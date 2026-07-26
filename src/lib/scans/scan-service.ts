import { resolveInstallationScanPolicy, type ScanExecutionPolicy } from "@/lib/settings/settings-service";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import { PRODUCT_SCAN_MAX_DURATION_MS } from "@/lib/ikas/product-adapter";
import { collectProductHealthReport } from "@/lib/ikas/report-service";
import type { HealthReport, IkasProduct } from "@/lib/ikas/types";
import {
  collectStockObservations,
  type StockObservationSet,
} from "@/lib/alerts/stock-observation";
import {
  createSnapshotStore,
  hasActiveScanLease,
  SnapshotStoreError,
  type ScanSnapshot,
  type SnapshotStore,
} from "./snapshot-store";

/**
 * The explicit scan operation.
 *
 * A scan is tenant-bound, serialized per installation by a short lease, and only ever
 * replaces the latest snapshot after the upstream read has fully succeeded. A scan-limit
 * or upstream failure therefore leaves the previous successful snapshot readable.
 */

/**
 * The lease has to outlive the slowest scan it protects, not merely the catalog read.
 * A worst-case scan spends `PRODUCT_SCAN_MAX_DURATION_MS` (45s) paging the catalog and
 * then still has to build the report, serialize it, and complete the Redis write. At the
 * previous 60s the margin for all of that was 15s: a slow write could let the lease lapse
 * mid-scan, admitting a second scan that races the first one's snapshot write.
 *
 * Doubling the catalog budget leaves 45s of headroom while staying well inside the store's
 * maximum lease TTL, so a crashed scan still frees the installation quickly.
 */
export const SCAN_LEASE_TTL_MS = PRODUCT_SCAN_MAX_DURATION_MS * 2;

export class ScanBusyError extends Error {
  readonly code = "IKAS_SCAN_ALREADY_RUNNING" as const;

  constructor() {
    super("IKAS_SCAN_ALREADY_RUNNING");
    this.name = "ScanBusyError";
  }
}

export type ManualScanDependencies = {
  collectReport(
    now: Date,
    installation: InstallationIdentity,
    lowStockThreshold: number,
    observe?: (products: IkasProduct[]) => void,
  ): Promise<HealthReport>;
  /** One active-Pro decision resolves both history retention and the low-stock threshold. */
  resolvePolicy(installation: InstallationIdentity): Promise<ScanExecutionPolicy>;
  snapshotStore: SnapshotStore;
  now(): Date;
  createScanId(): string;
  createLeaseOwnerId(): string;
  leaseTtlMs?: number;
};

let configuredSnapshotStore: SnapshotStore | undefined;

function defaultDependencies(): ManualScanDependencies {
  configuredSnapshotStore ??= createSnapshotStore();
  return {
    collectReport: (now, installation, lowStockThreshold, observe) =>
      collectProductHealthReport(now, installation, { lowStockThreshold, ...(observe ? { observe } : {}) }),
    resolvePolicy: (installation) => resolveInstallationScanPolicy(installation),
    snapshotStore: configuredSnapshotStore,
    now: () => new Date(),
    createScanId: () => crypto.randomUUID(),
    createLeaseOwnerId: () => crypto.randomUUID(),
  };
}

export type ScheduledScanDependencies = Omit<ManualScanDependencies, "resolvePolicy">;

/** A scan result plus the per-location stock projection low-stock alerting needs. */
export type ScanExecutionResult = {
  snapshot: ScanSnapshot;
  observationSet: StockObservationSet;
};

async function executeScan(
  installation: InstallationIdentity,
  policy: ScanExecutionPolicy,
  dependencies: ScheduledScanDependencies,
): Promise<ScanExecutionResult> {
  const tenant = {
    authorizedAppId: installation.authorizedAppId,
    merchantId: installation.merchantId,
  };

  const lease = await dependencies.snapshotStore.acquireScanLease(
    tenant,
    dependencies.createLeaseOwnerId(),
    dependencies.leaseTtlMs ?? SCAN_LEASE_TTL_MS,
  );
  if (!lease) throw new ScanBusyError();

  try {
    const now = dependencies.now();
    let observationSet: StockObservationSet = { observations: [], truncated: false };
    const report = await dependencies.collectReport(
      now,
      installation,
      policy.lowStockThreshold,
      (products) => {
        observationSet = collectStockObservations(products);
      },
    );
    const snapshot: ScanSnapshot = {
      version: 1,
      scanId: dependencies.createScanId(),
      ...tenant,
      generatedAt: now.toISOString(),
      report,
    };
    await dependencies.snapshotStore.putLatest(snapshot, lease, policy.retention);
    return { snapshot, observationSet };
  } finally {
    await dependencies.snapshotStore.releaseScanLease(lease).catch(() => undefined);
  }
}

export async function runManualScan(
  installation?: InstallationIdentity | null,
  dependencies: ManualScanDependencies = defaultDependencies(),
): Promise<ScanSnapshot> {
  // Tenant identity is whatever the caller resolved from the sealed server session.
  // Nothing here reads request input, so no client value can select an installation.
  if (!installation) throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");

  // Licence IO happens before the scan lease so its timeout cannot consume the catalog/write
  // budget. The resolver is fail-closed: anything except an active, tenant-bound Pro grant is
  // latest-only with threshold 0, while the Free manual scan remains available.
  const policy = await dependencies.resolvePolicy(installation);
  return (await executeScan(installation, policy, dependencies)).snapshot;
}

/** Runs a scan from one already-authorized scheduler decision, avoiding a second entitlement read. */
export async function runScheduledScan(
  installation: InstallationIdentity,
  policy: ScanExecutionPolicy,
  dependencies: ScheduledScanDependencies = defaultDependencies(),
): Promise<ScanExecutionResult> {
  return executeScan(installation, policy, dependencies);
}

export type ScanStatusDependencies = {
  snapshotStore: Pick<SnapshotStore, "hasActiveScanLease">;
};

const defaultScanStatusDependencies: ScanStatusDependencies = {
  // The module-level accessor, so this shares the configured store without constructing one
  // per call and stays mockable at the same boundary the snapshot read uses.
  snapshotStore: { hasActiveScanLease },
};

/**
 * Whether a scan is currently running for this installation.
 *
 * This exists so a merchant who reloads the dashboard mid-scan still sees `Tarama sürüyor`,
 * rather than a live button that only went quiet for the one render that followed a
 * `?scan=busy` redirect. It is a Redis read and nothing else: no catalog call, no licence or
 * entitlement lookup, and no token exchange, so putting it on the dashboard read path costs
 * one key lookup.
 *
 * The tenant comes from the sealed server session the caller already resolved; no request
 * input reaches this function, so no client value can select an installation.
 *
 * It is an affordance, not a guard. `POST /api/scans` still holds the authoritative
 * `SET NX` lease, so a stale or unreadable answer here can only make the button look
 * available — never let a duplicate scan through.
 */
export async function isScanRunning(
  installation?: InstallationIdentity | null,
  dependencies: ScanStatusDependencies = defaultScanStatusDependencies,
): Promise<boolean> {
  if (!installation) throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");

  try {
    return await dependencies.snapshotStore.hasActiveScanLease({
      authorizedAppId: installation.authorizedAppId,
      merchantId: installation.merchantId,
    });
  } catch (error) {
    // An unreachable lease store must not take down a dashboard that renders fine from an
    // already-loaded snapshot. Unknown reads as "not running" because the server-side 409
    // is what actually prevents the duplicate scan.
    if (error instanceof SnapshotStoreError) return false;
    throw error;
  }
}
