import { describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError, IkasUpstreamError } from "./errors";
import {
  collectProductHealthReport,
  getLatestProductHealthReport,
  getProductHealthReportCsv,
  type ProductHealthReadDependencies,
  type ProductHealthScanDependencies,
} from "./report-service";
import { TokenStoreError, type StoredIkasToken } from "./token-store";
import { SnapshotStoreError, type ScanSnapshot } from "@/lib/scans/snapshot-store";
import type { HealthReport } from "./types";

const storedToken: StoredIkasToken = {
  authorizedAppId: "authorized-app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
  accessToken: "access-token",
};

const installation = {
  authorizedAppId: storedToken.authorizedAppId,
  merchantId: storedToken.merchantId!,
  storeName: storedToken.storeName!,
};

const report: HealthReport = {
  generatedAt: "2026-07-20T08:00:00.000Z",
  score: 82,
  productCount: 1,
  variantCount: 1,
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
    missing_price: 0,
    duplicate_title: 0,
    weird_description: 0,
  },
  criticalCount: 1,
  warningCount: 0,
  infoCount: 0,
  outOfStockBlockedCount: 0,
  ruleSummaries: [{ code: "missing_sku", label: "SKU Eksik", count: 1 }],
  productRows: [],
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

const snapshot: ScanSnapshot = {
  version: 1,
  scanId: "scan-1",
  authorizedAppId: installation.authorizedAppId,
  merchantId: installation.merchantId,
  generatedAt: "2026-07-20T08:00:00.000Z",
  report,
};

function createScanDependencies(
  listProducts = vi.fn().mockResolvedValue({ source: "http", products: [] }),
) {
  const getToken = vi.fn().mockResolvedValue(storedToken);
  const invalidateToken = vi.fn().mockResolvedValue(undefined);
  const createAdapter = vi.fn(() => ({ listProducts }));
  const dependencies = { getToken, invalidateToken, createAdapter } as unknown as ProductHealthScanDependencies;
  return { createAdapter, dependencies, getToken, invalidateToken, listProducts };
}

/** Fixed clock: freshness is an injected input, so the assertions stay deterministic. */
const SCAN_TIME_MS = Date.parse("2026-07-20T08:00:00.000Z");

function createReadDependencies(
  { latest, now }: { latest?: ScanSnapshot; now?: () => number } = { latest: snapshot },
) {
  const getToken = vi.fn().mockResolvedValue(storedToken);
  const getLatestSnapshot = vi.fn().mockResolvedValue(latest);
  const createAdapter = vi.fn();
  const dependencies = {
    getToken,
    getLatestSnapshot,
    now: now ?? (() => SCAN_TIME_MS),
  } as unknown as ProductHealthReadDependencies;
  return { createAdapter, dependencies, getLatestSnapshot, getToken };
}

describe("collectProductHealthReport authentication lifecycle", () => {
  it("keeps the scan path on the live HTTP adapter", async () => {
    const fixture = createScanDependencies();

    const result = await collectProductHealthReport(
      new Date("2026-07-13T10:00:00.000Z"),
      installation,
      fixture.dependencies,
    );

    expect(result.scanStatus).toBe("success");
    expect(fixture.createAdapter).toHaveBeenCalledWith(expect.stringMatching(/^https:/), "access-token");
    expect(fixture.listProducts).toHaveBeenCalledOnce();
  });

  it("invalidates a token only after a confirmed API authentication failure", async () => {
    const fixture = createScanDependencies(
      vi.fn().mockRejectedValue(new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED")),
    );

    await expect(
      collectProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toBeInstanceOf(IkasAuthenticationError);
    expect(fixture.invalidateToken).toHaveBeenCalledWith(storedToken.authorizedAppId, storedToken);
  });

  it("does not invalidate a token for a transient upstream failure", async () => {
    const fixture = createScanDependencies(
      vi.fn().mockRejectedValue(new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR")),
    );

    await expect(
      collectProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toBeInstanceOf(IkasUpstreamError);
    expect(fixture.invalidateToken).not.toHaveBeenCalled();
  });

  it("does not turn a token-store backend failure into a missing-token response", async () => {
    const fixture = createScanDependencies();
    fixture.getToken.mockRejectedValue(new TokenStoreError("backend", "get"));

    await expect(
      collectProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toMatchObject({ code: "backend", operation: "get" });
    expect(fixture.createAdapter).not.toHaveBeenCalled();
    expect(fixture.invalidateToken).not.toHaveBeenCalled();
  });

  it("requires an installation session before consulting the token store", async () => {
    const fixture = createScanDependencies();

    await expect(
      collectProductHealthReport(new Date(), undefined, fixture.dependencies),
    ).rejects.toMatchObject({ code: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(fixture.getToken).not.toHaveBeenCalled();
    expect(fixture.createAdapter).not.toHaveBeenCalled();
  });

  it("requires a matching durable token and never falls back to mock data", async () => {
    const fixture = createScanDependencies();
    fixture.getToken.mockResolvedValue(undefined);

    await expect(
      collectProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toMatchObject({ code: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(fixture.getToken).toHaveBeenCalledWith(installation.authorizedAppId);
    expect(fixture.createAdapter).not.toHaveBeenCalled();
  });

  it.each([
    { merchantId: "merchant-2" },
    { storeName: "other-store" },
    { authorizedAppId: "authorized-app-2" },
  ])("rejects a persisted cross-tenant token before creating an API adapter: %j", async (override) => {
    const fixture = createScanDependencies();
    fixture.getToken.mockResolvedValue({ ...storedToken, ...override });

    await expect(
      collectProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toMatchObject({ code: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(fixture.createAdapter).not.toHaveBeenCalled();
    expect(fixture.invalidateToken).not.toHaveBeenCalled();
  });
});

describe("getLatestProductHealthReport read path", () => {
  it("serves the stored snapshot without calling the ikas catalog", async () => {
    const fixture = createReadDependencies();

    const result = await getLatestProductHealthReport(installation, fixture.dependencies);

    expect(result).toEqual({ source: "snapshot", snapshot, stale: false });
    expect(fixture.getLatestSnapshot).toHaveBeenCalledWith({
      authorizedAppId: installation.authorizedAppId,
      merchantId: installation.merchantId,
    });
    expect(fixture.createAdapter).not.toHaveBeenCalled();
  });

  it("marks a snapshot older than the freshness window as stale without hiding it", async () => {
    const fixture = createReadDependencies({
      latest: snapshot,
      now: () => SCAN_TIME_MS + 25 * 60 * 60_000,
    });

    await expect(getLatestProductHealthReport(installation, fixture.dependencies)).resolves.toEqual({
      source: "snapshot",
      snapshot,
      stale: true,
    });
  });

  it("reports a first-scan state instead of scanning when no snapshot exists", async () => {
    const fixture = createReadDependencies({});

    await expect(getLatestProductHealthReport(installation, fixture.dependencies)).resolves.toEqual({
      source: "none",
    });
    expect(fixture.createAdapter).not.toHaveBeenCalled();
  });

  it("still requires a live tenant-bound token before releasing a stored snapshot", async () => {
    const fixture = createReadDependencies();
    fixture.getToken.mockResolvedValue(undefined);

    await expect(
      getLatestProductHealthReport(installation, fixture.dependencies),
    ).rejects.toMatchObject({ code: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(fixture.getLatestSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { merchantId: "merchant-2" },
    { storeName: "other-store" },
    { authorizedAppId: "authorized-app-2" },
  ])("refuses to read a snapshot with a cross-tenant token: %j", async (override) => {
    const fixture = createReadDependencies();
    fixture.getToken.mockResolvedValue({ ...storedToken, ...override });

    await expect(
      getLatestProductHealthReport(installation, fixture.dependencies),
    ).rejects.toMatchObject({ code: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(fixture.getLatestSnapshot).not.toHaveBeenCalled();
  });

  it("requires an installation session", async () => {
    const fixture = createReadDependencies();

    await expect(
      getLatestProductHealthReport(undefined, fixture.dependencies),
    ).rejects.toBeInstanceOf(IkasAuthenticationError);
    expect(fixture.getToken).not.toHaveBeenCalled();
  });

  it("propagates a corrupt stored record instead of silently showing an empty report", async () => {
    const fixture = createReadDependencies();
    fixture.getLatestSnapshot.mockRejectedValue(new SnapshotStoreError("corrupt_record", "get"));

    await expect(
      getLatestProductHealthReport(installation, fixture.dependencies),
    ).rejects.toBeInstanceOf(SnapshotStoreError);
  });
});

describe("getProductHealthReportCsv", () => {
  it("derives CSV from the same stored snapshot without a second scan", async () => {
    const fixture = createReadDependencies();

    const csv = await getProductHealthReportCsv(installation, fixture.dependencies);

    expect(csv).toContain("missing_sku");
    expect(csv).toContain("Eksik SKU Ürünü");
    expect(fixture.getLatestSnapshot).toHaveBeenCalledOnce();
    expect(fixture.createAdapter).not.toHaveBeenCalled();
  });

  it("returns nothing to export when no scan has run yet", async () => {
    const fixture = createReadDependencies({});

    await expect(getProductHealthReportCsv(installation, fixture.dependencies)).resolves.toBeUndefined();
  });
});
