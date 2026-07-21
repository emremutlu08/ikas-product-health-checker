import { beforeEach, describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError, IkasUpstreamError } from "@/lib/ikas/errors";
import { PRODUCT_SCAN_MAX_DURATION_MS } from "@/lib/ikas/product-adapter";
import type { HealthReport } from "@/lib/ikas/types";
import { MemorySnapshotStore, SnapshotStoreError, type ScanSnapshot } from "./snapshot-store";
import {
  isScanRunning,
  runManualScan,
  SCAN_LEASE_TTL_MS,
  ScanBusyError,
  type ManualScanDependencies,
} from "./scan-service";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
};

const otherInstallation = {
  authorizedAppId: "app-2",
  merchantId: "merchant-2",
  storeName: "other-store",
};

/** Aggregates mirror the rows exactly; the store refuses a report that contradicts itself. */
function reportFor(score = 82, generatedAt = "2026-07-20T08:00:00.000Z"): HealthReport {
  return {
    generatedAt,
    score,
    productCount: 3,
    variantCount: 5,
    issueCount: 1,
    affectedProductCount: 1,
    scanStatus: "success",
    issueCountsByCode: {
      missing_sku: 1,
      missing_barcode: 0,
      duplicate_sku: 0,
      duplicate_barcode: 0,
      missing_image: 0,
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
    criticalCount: 1,
    warningCount: 0,
    infoCount: 0,
    outOfStockBlockedCount: 0,
    ruleSummaries: [
      { code: "incorrect_price", label: "Hatalı Fiyat", count: 0 },
      { code: "out_of_stock", label: "Stokta Yok", count: 0 },
      { code: "missing_images", label: "Görsel Eksik", count: 0 },
      { code: "missing_sku", label: "SKU Eksik", count: 1 },
      { code: "same_sku", label: "Aynı SKU", count: 0 },
      { code: "duplicate_title", label: "Tekrarlanan Başlık", count: 0 },
      { code: "weird_description", label: "Sorunlu Açıklama", count: 0 },
    ],
    productRows: [
      {
        productId: "product-1",
        productName: "Eksik SKU Ürünü",
        imageLabel: "ES",
        mistakes: ["SKU Eksik"],
        actionLabel: "İncele",
      },
    ],
    issues: [
      {
        code: "missing_sku",
        severity: "critical",
        productId: "product-1",
        productName: "Eksik SKU Ürünü",
        message: "SKU yok.",
      },
    ],
  };
}

function previousSnapshot(): ScanSnapshot {
  return {
    version: 1,
    scanId: "scan-previous",
    authorizedAppId: installation.authorizedAppId,
    merchantId: installation.merchantId,
    generatedAt: "2026-07-19T08:00:00.000Z",
    report: reportFor(40, "2026-07-19T08:00:00.000Z"),
  };
}

function createFixture(
  collectReport = vi.fn().mockResolvedValue(reportFor()),
  resolvePolicy = vi.fn().mockResolvedValue({ retention: { historyEnabled: false }, lowStockThreshold: 0 }),
) {
  const snapshotStore = new MemorySnapshotStore();
  let scanCounter = 0;
  const dependencies: ManualScanDependencies = {
    collectReport,
    resolvePolicy,
    snapshotStore,
    now: () => new Date("2026-07-20T08:00:00.000Z"),
    createScanId: () => `scan-${++scanCounter}`,
    createLeaseOwnerId: () => `owner-${scanCounter}`,
  };
  return { collectReport, dependencies, snapshotStore };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runManualScan", () => {
  it("calls the ikas report source exactly once and persists exactly one snapshot", async () => {
    const fixture = createFixture();
    const putLatest = vi.spyOn(fixture.snapshotStore, "putLatest");

    const snapshot = await runManualScan(installation, fixture.dependencies);

    expect(fixture.collectReport).toHaveBeenCalledOnce();
    expect(putLatest).toHaveBeenCalledOnce();
    expect(snapshot).toEqual({
      version: 1,
      scanId: "scan-1",
      authorizedAppId: "app-1",
      merchantId: "merchant-1",
      generatedAt: "2026-07-20T08:00:00.000Z",
      report: reportFor(),
    });
    await expect(fixture.snapshotStore.getLatest(installation)).resolves.toEqual(snapshot);
  });

  it("publishes an explicit latest-only retention decision for Free scans", async () => {
    const fixture = createFixture();
    const putLatest = vi.spyOn(fixture.snapshotStore, "putLatest");

    await runManualScan(installation, fixture.dependencies);

    expect(fixture.dependencies.resolvePolicy).toHaveBeenCalledWith(installation);
    expect(putLatest).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: "scan-1" }),
      expect.objectContaining({ authorizedAppId: installation.authorizedAppId }),
      { historyEnabled: false },
    );
  });

  it("retains a bounded history only when the server-side resolver grants it", async () => {
    const fixture = createFixture(
      vi.fn().mockResolvedValue(reportFor()),
      vi.fn().mockResolvedValue({ retention: { historyEnabled: true }, lowStockThreshold: 0 }),
    );

    await runManualScan(installation, fixture.dependencies);

    await expect(
      fixture.snapshotStore.listHistory(installation, { historyEnabled: true }),
    ).resolves.toMatchObject([{ scanId: "scan-1" }]);
  });

  it("passes the policy's low-stock threshold to the report source, resolved before the lease", async () => {
    const order: string[] = [];
    const collectReport = vi.fn().mockImplementation(async () => {
      order.push("collect");
      return reportFor();
    });
    const resolvePolicy = vi.fn().mockImplementation(async () => {
      order.push("policy");
      return { retention: { historyEnabled: true }, lowStockThreshold: 25 };
    });
    const fixture = createFixture(collectReport, resolvePolicy);

    await runManualScan(installation, fixture.dependencies);

    expect(collectReport).toHaveBeenCalledWith(expect.any(Date), installation, 25);
    // The licence/settings decision resolves before the scan begins.
    expect(order).toEqual(["policy", "collect"]);
  });

  it("scans latest-only with threshold 0 when the policy denies Pro, without blocking the scan", async () => {
    const collectReport = vi.fn().mockResolvedValue(reportFor());
    const fixture = createFixture(
      collectReport,
      vi.fn().mockResolvedValue({ retention: { historyEnabled: false }, lowStockThreshold: 0 }),
    );

    await expect(runManualScan(installation, fixture.dependencies)).resolves.toMatchObject({
      scanId: "scan-1",
    });
    expect(collectReport).toHaveBeenCalledWith(expect.any(Date), installation, 0);
    await expect(
      fixture.snapshotStore.listHistory(installation, { historyEnabled: true }),
    ).resolves.toEqual([]);
  });

  it("binds the persisted snapshot to the server-side installation, not to the report body", async () => {
    const fixture = createFixture();

    const snapshot = await runManualScan(installation, fixture.dependencies);

    expect(snapshot.authorizedAppId).toBe(installation.authorizedAppId);
    expect(snapshot.merchantId).toBe(installation.merchantId);
    expect(JSON.stringify(snapshot)).not.toContain("accessToken");
    await expect(fixture.snapshotStore.getLatest(otherInstallation)).resolves.toBeUndefined();
  });

  it("refuses to scan without a server-side installation session", async () => {
    const fixture = createFixture();
    const acquireScanLease = vi.spyOn(fixture.snapshotStore, "acquireScanLease");

    await expect(runManualScan(undefined, fixture.dependencies)).rejects.toBeInstanceOf(
      IkasAuthenticationError,
    );
    expect(acquireScanLease).not.toHaveBeenCalled();
    expect(fixture.collectReport).not.toHaveBeenCalled();
  });

  it("rejects a concurrent duplicate scan for the same installation without a second upstream call", async () => {
    let release!: (report: HealthReport) => void;
    const pending = new Promise<HealthReport>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture(vi.fn().mockReturnValue(pending));

    const first = runManualScan(installation, fixture.dependencies);
    await expect(runManualScan(installation, fixture.dependencies)).rejects.toBeInstanceOf(
      ScanBusyError,
    );

    release(reportFor());
    await expect(first).resolves.toMatchObject({ scanId: "scan-1" });
    expect(fixture.collectReport).toHaveBeenCalledOnce();
  });

  it("does not let one installation's running scan block another installation", async () => {
    const fixture = createFixture();

    await runManualScan(installation, fixture.dependencies);

    await expect(runManualScan(otherInstallation, fixture.dependencies)).resolves.toMatchObject({
      authorizedAppId: "app-2",
    });
  });

  it("releases the lease after a successful scan so the merchant can re-scan", async () => {
    const fixture = createFixture();

    await runManualScan(installation, fixture.dependencies);

    await expect(runManualScan(installation, fixture.dependencies)).resolves.toMatchObject({
      scanId: "scan-2",
    });
  });

  it.each([
    { name: "a scan-limit failure", error: new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED") },
    { name: "an upstream transport failure", error: new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR") },
    { name: "an authentication failure", error: new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED") },
  ])("leaves the previous successful snapshot intact after $name", async ({ error }) => {
    const fixture = createFixture(vi.fn().mockRejectedValue(error));
    await fixture.snapshotStore.putLatest(previousSnapshot());
    const putLatest = vi.spyOn(fixture.snapshotStore, "putLatest");

    await expect(runManualScan(installation, fixture.dependencies)).rejects.toBe(error);

    expect(putLatest).not.toHaveBeenCalled();
    await expect(fixture.snapshotStore.getLatest(installation)).resolves.toEqual(previousSnapshot());
  });

  it("releases the lease after a failed scan so a retry is possible", async () => {
    const collectReport = vi
      .fn()
      .mockRejectedValueOnce(new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR"))
      .mockResolvedValueOnce(reportFor());
    const fixture = createFixture(collectReport);

    await expect(runManualScan(installation, fixture.dependencies)).rejects.toBeInstanceOf(
      IkasUpstreamError,
    );

    // The failed attempt never reached snapshot creation, so the retry takes the first id.
    await expect(runManualScan(installation, fixture.dependencies)).resolves.toMatchObject({
      scanId: "scan-1",
    });
  });

  it("holds the lease past the full catalog scan budget plus the snapshot write", async () => {
    // A lease that can expire mid-scan lets a second scan start and race the first one's
    // write, so the TTL has to outlast the worst-case scan by a real margin.
    expect(SCAN_LEASE_TTL_MS).toBeGreaterThanOrEqual(PRODUCT_SCAN_MAX_DURATION_MS * 2);

    const fixture = createFixture();
    const acquireScanLease = vi.spyOn(fixture.snapshotStore, "acquireScanLease");

    await runManualScan(installation, fixture.dependencies);

    expect(acquireScanLease).toHaveBeenCalledWith(
      expect.objectContaining({ authorizedAppId: "app-1" }),
      expect.any(String),
      SCAN_LEASE_TTL_MS,
    );
  });

  it("surfaces a snapshot write failure instead of reporting a scan that was never stored", async () => {
    const fixture = createFixture();
    vi.spyOn(fixture.snapshotStore, "putLatest").mockRejectedValue(new Error("redis down"));

    await expect(runManualScan(installation, fixture.dependencies)).rejects.toThrow("redis down");
  });
});

/**
 * The read-only counterpart to the lease `runManualScan` takes. It exists so a merchant sees
 * `Tarama sürüyor` on a fresh page load rather than only after being bounced back with
 * `?scan=busy`, and it deliberately touches nothing but Redis.
 */
describe("isScanRunning", () => {
  it("reports a scan that another request is currently holding the lease for", async () => {
    const snapshotStore = new MemorySnapshotStore();
    await snapshotStore.acquireScanLease(installation, "owner-1", 30_000);

    await expect(isScanRunning(installation, { snapshotStore })).resolves.toBe(true);
  });

  it("reports no scan when the installation holds no lease", async () => {
    const snapshotStore = new MemorySnapshotStore();

    await expect(isScanRunning(installation, { snapshotStore })).resolves.toBe(false);
  });

  it("reads the lease for the session installation only, never a caller-supplied tenant", async () => {
    const snapshotStore = new MemorySnapshotStore();
    const hasActiveScanLease = vi.spyOn(snapshotStore, "hasActiveScanLease");
    await snapshotStore.acquireScanLease(otherInstallation, "owner-1", 30_000);

    await expect(isScanRunning(installation, { snapshotStore })).resolves.toBe(false);
    expect(hasActiveScanLease).toHaveBeenCalledWith({
      authorizedAppId: "app-1",
      merchantId: "merchant-1",
    });
    // The store name travels in the session but is not part of the tenant key.
    expect(hasActiveScanLease.mock.calls[0]?.[0]).not.toHaveProperty("storeName");
  });

  it("refuses to read a lease without a server-side installation session", async () => {
    const snapshotStore = new MemorySnapshotStore();
    const hasActiveScanLease = vi.spyOn(snapshotStore, "hasActiveScanLease");

    await expect(isScanRunning(undefined, { snapshotStore })).rejects.toBeInstanceOf(
      IkasAuthenticationError,
    );
    expect(hasActiveScanLease).not.toHaveBeenCalled();
  });

  it("never reaches the ikas catalog to answer whether a scan is running", async () => {
    const snapshotStore = new MemorySnapshotStore();
    const collectReport = vi.fn();
    await snapshotStore.acquireScanLease(installation, "owner-1", 30_000);

    await isScanRunning(installation, { snapshotStore });

    expect(collectReport).not.toHaveBeenCalled();
  });

  /**
   * A lease read is an affordance, not a guarantee: `POST /api/scans` still refuses a duplicate
   * with its own `SET NX`. So an unreachable store degrades to "not known to be running" and
   * leaves the button live, rather than failing the whole dashboard render.
   */
  it("degrades to no-known-scan when the lease store is unreachable", async () => {
    const snapshotStore = new MemorySnapshotStore();
    vi.spyOn(snapshotStore, "hasActiveScanLease").mockRejectedValue(
      new SnapshotStoreError("backend", "lease"),
    );

    await expect(isScanRunning(installation, { snapshotStore })).resolves.toBe(false);
  });
});
