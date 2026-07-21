import { IkasAuthenticationError } from "@/lib/ikas/errors";
import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import { PRODUCT_SCAN_MAX_DURATION_MS } from "@/lib/ikas/product-adapter";
import { collectProductHealthReport } from "@/lib/ikas/report-service";
import type { HealthReport } from "@/lib/ikas/types";
import {
  createSnapshotStore,
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
  collectReport(now: Date, installation: InstallationIdentity): Promise<HealthReport>;
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
    collectReport: (now, installation) => collectProductHealthReport(now, installation),
    snapshotStore: configuredSnapshotStore,
    now: () => new Date(),
    createScanId: () => crypto.randomUUID(),
    createLeaseOwnerId: () => crypto.randomUUID(),
  };
}

export async function runManualScan(
  installation?: InstallationIdentity | null,
  dependencies: ManualScanDependencies = defaultDependencies(),
): Promise<ScanSnapshot> {
  // Tenant identity is whatever the caller resolved from the sealed server session.
  // Nothing here reads request input, so no client value can select an installation.
  if (!installation) throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");

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
    const report = await dependencies.collectReport(now, installation);

    const snapshot: ScanSnapshot = {
      version: 1,
      scanId: dependencies.createScanId(),
      ...tenant,
      generatedAt: now.toISOString(),
      report,
    };

    // Written only after a fully successful upstream read, and guarded by the lease so a
    // scan that lost its lease cannot overwrite a newer snapshot.
    await dependencies.snapshotStore.putLatest(snapshot, lease);
    return snapshot;
  } finally {
    await dependencies.snapshotStore.releaseScanLease(lease).catch(() => undefined);
  }
}
