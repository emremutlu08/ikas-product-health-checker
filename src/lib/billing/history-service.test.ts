import { describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import type { HealthIssue, HealthReport } from "@/lib/ikas/types";
import type { ScanSnapshot } from "@/lib/scans/snapshot-store";
import type { Entitlement } from "./entitlement-service";
import { ISSUE_TO_RULE } from "@/lib/ikas/health-rules";
import {
  HistoryAccessError,
  getProductHealthHistory,
  type ProductHealthHistoryDependencies,
} from "./history-service";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "store-1",
};

function healthIssue(productId: string, code: HealthIssue["code"] = "missing_sku"): HealthIssue {
  return {
    code,
    severity: "critical",
    productId,
    productName: `Product ${productId}`,
    message: "Issue",
  };
}

function report(generatedAt: string, issues: HealthIssue[]): HealthReport {
  return {
    generatedAt,
    score: 50,
    productCount: Math.max(issues.length, 1),
    variantCount: 0,
    // Mirrors production: the merchant-facing count excludes codes that reach no rule card.
    issueCount: issues.filter((issue) => ISSUE_TO_RULE[issue.code] !== undefined).length,
    affectedProductCount: new Set(issues.map((issue) => issue.productId)).size,
    scanStatus: "success",
    issueCountsByCode: {
      missing_sku: issues.filter((issue) => issue.code === "missing_sku").length,
      missing_barcode: 0,
      duplicate_sku: 0,
      duplicate_barcode: 0,
      missing_image: issues.filter((issue) => issue.code === "missing_image").length,
      missing_description: 0,
      missing_category: 0,
      missing_brand: 0,
      missing_vendor: 0,
      zero_stock_blocked: 0,
      low_stock: 0,
      missing_price: 0,
      duplicate_title: 0,
      weird_description: 0,
    },
    criticalCount: issues.length,
    warningCount: 0,
    infoCount: 0,
    outOfStockBlockedCount: 0,
    ruleSummaries: [],
    productRows: [],
    issues,
  };
}

function snapshot(scanId: string, generatedAt: string, issues: HealthIssue[]): ScanSnapshot {
  return {
    version: 1,
    scanId,
    ...installation,
    generatedAt,
    report: report(generatedAt, issues),
  };
}

const activePro: Entitlement = {
  authorizedAppId: installation.authorizedAppId,
  merchantId: installation.merchantId,
  tier: "pro" as const,
  state: "active" as const,
  planKey: "productHealthPro",
  reason: "ACTIVE_KNOWN_PLAN" as const,
};

function dependencies(
  entitlement: Entitlement = activePro,
  history: ScanSnapshot[] = [],
): ProductHealthHistoryDependencies {
  return {
    resolveEntitlement: vi.fn().mockResolvedValue(entitlement),
    listHistory: vi.fn().mockResolvedValue(history),
  };
}

describe("getProductHealthHistory", () => {
  it("requires a sealed installation before resolving entitlement", async () => {
    const deps = dependencies();

    await expect(getProductHealthHistory(undefined, deps)).rejects.toBeInstanceOf(
      IkasAuthenticationError,
    );
    expect(deps.resolveEntitlement).not.toHaveBeenCalled();
    expect(deps.listHistory).not.toHaveBeenCalled();
  });

  it.each([
    { state: "inactive", tier: "free", reason: "NO_MATCHING_SUBSCRIPTION" },
    { state: "unknown", tier: "free", reason: "LICENCE_UNAVAILABLE" },
    { state: "denied", tier: "free", reason: "MERCHANT_MISMATCH" },
  ] as const)("denies $state before touching history storage", async (entitlement) => {
    const deps = dependencies({
      ...activePro,
      ...entitlement,
      merchantId: entitlement.state === "denied" ? null : installation.merchantId,
      planKey: undefined,
    });

    await expect(getProductHealthHistory(installation, deps)).rejects.toMatchObject({
      code: "IKAS_PRO_FEATURE_REQUIRED",
    });
    expect(deps.listHistory).not.toHaveBeenCalled();
  });

  it("reads the tenant history only after an active Pro grant", async () => {
    const deps = dependencies(activePro, []);

    await expect(getProductHealthHistory(installation, deps)).resolves.toEqual({
      tier: "pro",
      entries: [],
    });
    expect(deps.listHistory).toHaveBeenCalledWith(
      {
        authorizedAppId: installation.authorizedAppId,
        merchantId: installation.merchantId,
      },
      { historyEnabled: true },
    );
  });

  it("projects newest-first snapshots into bounded summaries and deterministic diff counts", async () => {
    const oldIssue = healthIssue("old");
    const ongoingBefore = healthIssue("ongoing");
    const ongoingNow = { ...ongoingBefore, productName: "Renamed product", message: "Changed copy" };
    const added = healthIssue("added", "missing_image");
    const history = [
      snapshot("scan-2", "2026-07-22T08:00:00.000Z", [ongoingNow, added]),
      snapshot("scan-1", "2026-07-21T08:00:00.000Z", [oldIssue, ongoingBefore]),
    ];

    const result = await getProductHealthHistory(installation, dependencies(activePro, history));

    expect(result.entries).toMatchObject([
      {
        scanId: "scan-2",
        generatedAt: "2026-07-22T08:00:00.000Z",
        issueCount: 2,
        changes: { baseline: "available", added: 1, ongoing: 1, resolved: 1 },
      },
      {
        scanId: "scan-1",
        changes: { baseline: "missing", added: 0, ongoing: 0, resolved: 0 },
      },
    ]);
  });

  it("never exposes tenant ids or full issue rows in the merchant projection", async () => {
    const history = [snapshot("scan-1", "2026-07-21T08:00:00.000Z", [healthIssue("p-1")])];

    const result = await getProductHealthHistory(installation, dependencies(activePro, history));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(installation.authorizedAppId);
    expect(serialized).not.toContain(installation.merchantId);
    expect(serialized).not.toContain("Product p-1");
    expect(serialized).not.toContain('"issues"');
  });

  it("uses a typed access error rather than exposing entitlement internals", () => {
    expect(new HistoryAccessError()).toMatchObject({
      name: "HistoryAccessError",
      code: "IKAS_PRO_FEATURE_REQUIRED",
      message: "IKAS_PRO_FEATURE_REQUIRED",
    });
  });
});

/**
 * The history card shows a total and a change breakdown side by side. They are two views of the
 * same scan, so they have to reconcile — and they did not: the total counted only issues that
 * reach a rule card while the diff compared every stored detection, which put "Devam eden 289"
 * directly above "Toplam sorun: 257" on a real merchant's screen.
 */
describe("history arithmetic", () => {
  it("keeps the change breakdown reconciled with the issue count it sits beside", async () => {
    const invisible = healthIssue("product-9", "missing_vendor");
    const first = snapshot("scan-1", "2026-08-04T10:00:00.000Z", [
      healthIssue("product-1", "missing_sku"),
      invisible,
    ]);
    const second = snapshot("scan-2", "2026-08-05T10:00:00.000Z", [
      healthIssue("product-1", "missing_sku"),
      healthIssue("product-2", "missing_image"),
      invisible,
    ]);

    const history = await getProductHealthHistory(installation, dependencies(activePro, [second, first]));

    for (const entry of history.entries) {
      if (entry.changes.baseline === "missing") continue;
      expect(entry.changes.added + entry.changes.ongoing).toBe(entry.issueCount);
    }
  });

  it("never counts an issue the merchant cannot find on any rule card", async () => {
    const onlyInvisible = snapshot("scan-1", "2026-08-04T10:00:00.000Z", [
      healthIssue("product-1", "missing_vendor"),
      healthIssue("product-2", "missing_brand"),
    ]);
    const next = snapshot("scan-2", "2026-08-05T10:00:00.000Z", [
      healthIssue("product-1", "missing_vendor"),
      healthIssue("product-2", "missing_brand"),
    ]);

    const history = await getProductHealthHistory(installation, dependencies(activePro, [next, onlyInvisible]));
    const latest = history.entries[0]!;

    expect(latest.issueCount).toBe(0);
    expect(latest.changes).toMatchObject({ added: 0, ongoing: 0, resolved: 0 });
  });
});
