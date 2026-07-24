import { isFeatureEnabled } from "./feature-policy";
import {
  resolveInstallationEntitlement,
} from "./runtime-entitlement";
import type { Entitlement } from "./entitlement-service";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import { diffHealthIssues } from "@/lib/scans/issue-diff";
import {
  listSnapshotHistory,
  toSafeSnapshot,
  type ScanSnapshot,
  type SnapshotRetentionPolicy,
  type SnapshotTenant,
} from "@/lib/scans/snapshot-store";

export class HistoryAccessError extends Error {
  readonly code = "IKAS_PRO_FEATURE_REQUIRED" as const;

  constructor() {
    super("IKAS_PRO_FEATURE_REQUIRED");
    this.name = "HistoryAccessError";
  }
}

export type ProductHealthHistoryDependencies = {
  resolveEntitlement(installation: InstallationIdentity): Promise<Entitlement>;
  listHistory(
    tenant: SnapshotTenant,
    retention?: SnapshotRetentionPolicy,
  ): Promise<ScanSnapshot[]>;
};

const defaultDependencies: ProductHealthHistoryDependencies = {
  resolveEntitlement: resolveInstallationEntitlement,
  listHistory: listSnapshotHistory,
};

export type ProductHealthHistoryEntry = {
  scanId: string;
  generatedAt: string;
  health: ReturnType<typeof toSafeSnapshot>["health"];
  productCount: number;
  affectedProductCount: number;
  issueCount: number;
  changes: {
    baseline: "missing" | "available";
    added: number;
    ongoing: number;
    resolved: number;
  };
};

export type ProductHealthHistory = {
  tier: "pro";
  entries: ProductHealthHistoryEntry[];
};

/**
 * Explicit Pro boundary. Ordinary dashboard/filter reads never call this service and therefore
 * never perform a licence read. Storage is touched only after an active, tenant-bound Pro grant.
 */
export async function getProductHealthHistory(
  installation?: InstallationIdentity | null,
  dependencies: ProductHealthHistoryDependencies = defaultDependencies,
): Promise<ProductHealthHistory> {
  if (!installation) throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");

  const entitlement = await dependencies.resolveEntitlement(installation);
  if (
    entitlement.state !== "active" ||
    !isFeatureEnabled("scan-history", entitlement.tier)
  ) {
    throw new HistoryAccessError();
  }

  const snapshots = await dependencies.listHistory(
    {
      authorizedAppId: installation.authorizedAppId,
      merchantId: installation.merchantId,
    },
    { historyEnabled: true },
  );

  const entries = snapshots.map((snapshot, index): ProductHealthHistoryEntry => {
    const previous = snapshots[index + 1];
    const changes = diffHealthIssues(previous?.report.issues, snapshot.report.issues);
    const safe = toSafeSnapshot(snapshot);

    return {
      scanId: safe.scanId,
      generatedAt: safe.generatedAt,
      health: safe.health,
      productCount: safe.report.productCount,
      affectedProductCount: safe.report.affectedProductCount,
      issueCount: safe.report.issueCount,
      changes: {
        baseline: changes.baseline,
        added: changes.added.length,
        ongoing: changes.ongoing.length,
        resolved: changes.resolved.length,
      },
    };
  });

  return { tier: "pro", entries };
}
