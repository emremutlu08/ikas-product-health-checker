import { issuesToCsv } from "./csv";
import { buildHealthReport } from "./health-rules";
import { config } from "@/globals/config";
import { getIkasToken, invalidateIkasToken } from "./token-store";
import { HttpIkasProductAdapter, type IkasProductAdapter } from "./product-adapter";
import { IkasAuthenticationError } from "./errors";
import type { HealthReport } from "./types";
import { tokenMatchesInstallation, type InstallationIdentity } from "./installation-auth";
import { getLatestSnapshot, isSnapshotStale, type ScanSnapshot } from "@/lib/scans/snapshot-store";

/**
 * Scanning and viewing are separate operations.
 *
 * `collectProductHealthReport` is the only function that talks to the ikas catalog; it
 * runs exclusively from an explicit scan. Everything a merchant navigates — dashboard
 * render, rule filters, JSON report, CSV — goes through the snapshot read path below and
 * makes zero ikas product API calls.
 */

export type ProductHealthScanDependencies = {
  getToken: typeof getIkasToken;
  invalidateToken: typeof invalidateIkasToken;
  createAdapter(endpoint: string, accessToken: string): IkasProductAdapter;
};

export type ProductHealthReadDependencies = {
  getToken: typeof getIkasToken;
  getLatestSnapshot: typeof getLatestSnapshot;
  /** Injected so freshness stays a pure input to rendering rather than a render-time clock read. */
  now?: () => number;
};

export type ProductHealthSnapshotResult =
  | { source: "snapshot"; snapshot: ScanSnapshot; stale: boolean }
  | { source: "none" };

const defaultScanDependencies: ProductHealthScanDependencies = {
  getToken: getIkasToken,
  invalidateToken: invalidateIkasToken,
  createAdapter: (endpoint, accessToken) => new HttpIkasProductAdapter(endpoint, accessToken),
};

const defaultReadDependencies: ProductHealthReadDependencies = {
  getToken: getIkasToken,
  getLatestSnapshot,
};

/**
 * Resolves the durable token for an installation and fails closed unless it belongs to
 * exactly this tenant. Both the scan path and the read path go through this gate.
 */
async function requireTenantToken(
  installation: InstallationIdentity | null | undefined,
  getToken: typeof getIkasToken,
) {
  if (!installation) throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");

  const storedToken = await getToken(installation.authorizedAppId);
  if (!tokenMatchesInstallation(storedToken, installation)) {
    throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");
  }
  return storedToken;
}

/** Options that shape the report a scan produces, resolved by the caller's server-side policy. */
export type CollectProductHealthReportOptions = {
  /** Active-Pro configured low-stock threshold. 0 (the default) disables low-stock warnings. */
  lowStockThreshold?: number;
};

/** Live ikas catalog read. Only an explicit scan may call this. */
export async function collectProductHealthReport(
  now = new Date(),
  installation?: InstallationIdentity | null,
  options: CollectProductHealthReportOptions = {},
  dependencies: ProductHealthScanDependencies = defaultScanDependencies,
): Promise<HealthReport> {
  const storedToken = await requireTenantToken(installation, dependencies.getToken);

  const adapter = dependencies.createAdapter(config.graphApiUrl, storedToken.accessToken);
  try {
    const { products } = await adapter.listProducts();
    return buildHealthReport(products, now, {
      merchantId: storedToken.merchantId,
      lowStockThreshold: options.lowStockThreshold,
    });
  } catch (error) {
    if (error instanceof IkasAuthenticationError) {
      await dependencies.invalidateToken(installation!.authorizedAppId, storedToken);
    }
    throw error;
  }
}

/** Snapshot read. Never calls the ikas catalog and never triggers a scan. */
export async function getLatestProductHealthReport(
  installation?: InstallationIdentity | null,
  dependencies: ProductHealthReadDependencies = defaultReadDependencies,
): Promise<ProductHealthSnapshotResult> {
  await requireTenantToken(installation, dependencies.getToken);

  const snapshot = await dependencies.getLatestSnapshot({
    authorizedAppId: installation!.authorizedAppId,
    merchantId: installation!.merchantId,
  });

  if (!snapshot) return { source: "none" };
  return {
    source: "snapshot",
    snapshot,
    stale: isSnapshotStale(snapshot, (dependencies.now ?? Date.now)()),
  };
}

/** CSV is a projection of the same snapshot the dashboard renders. */
export async function getProductHealthReportCsv(
  installation?: InstallationIdentity | null,
  dependencies: ProductHealthReadDependencies = defaultReadDependencies,
): Promise<string | undefined> {
  const result = await getLatestProductHealthReport(installation, dependencies);
  if (result.source === "none") return undefined;
  return issuesToCsv(result.snapshot.report.issues);
}
