import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@/lib/ikas/types";
import type { ScanSnapshot } from "@/lib/scans/snapshot-store";

/**
 * The report service is deliberately NOT mocked here. The dashboard is wired to the real
 * read path, and the ikas product adapter is replaced by a spy, so "zero ikas catalog
 * calls" is proven by an observed call count rather than assumed from a mock boundary.
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  getIkasLaunchAuthenticationHref: vi.fn(),
  redirect: vi.fn(),
  getLatestSnapshot: vi.fn(),
  getIkasToken: vi.fn(),
  listProducts: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/ikas/installation-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ikas/installation-auth")>()),
  getIkasLaunchAuthenticationHref: mocks.getIkasLaunchAuthenticationHref,
}));

vi.mock("@/lib/scans/snapshot-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scans/snapshot-store")>()),
  getLatestSnapshot: mocks.getLatestSnapshot,
}));

vi.mock("@/lib/ikas/token-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ikas/token-store")>()),
  getIkasToken: mocks.getIkasToken,
}));

vi.mock("@/lib/ikas/product-adapter", () => ({
  HttpIkasProductAdapter: class {
    listProducts = mocks.listProducts;
  },
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/IkasAppBridgeReady", () => ({ IkasAppBridgeReady: () => null }));
vi.mock("@/components/ProductImagePreview", () => ({
  ProductImagePreview: ({ alt }: { alt: string }) => <span data-image-alt={alt} />,
}));

import Home from "./page";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
};

const storedToken = { ...installation, accessToken: "access-token" };

const report: HealthReport = {
  generatedAt: "2026-07-18T08:00:00.000Z",
  score: 82,
  productCount: 31,
  variantCount: 121,
  issueCount: 4,
  affectedProductCount: 2,
  scanStatus: "success",
  issueCountsByCode: {
    missing_sku: 1,
    missing_barcode: 0,
    duplicate_sku: 2,
    duplicate_barcode: 0,
    missing_image: 0,
    missing_description: 0,
    missing_category: 0,
    missing_brand: 0,
    missing_vendor: 0,
    zero_stock_blocked: 1,
    missing_price: 0,
    duplicate_title: 0,
    weird_description: 0,
  },
  criticalCount: 4,
  warningCount: 0,
  infoCount: 0,
  outOfStockBlockedCount: 1,
  ruleSummaries: [
    { code: "missing_sku", label: "SKU Eksik", count: 1 },
    { code: "same_sku", label: "Aynı SKU", count: 1 },
    { code: "out_of_stock", label: "Stokta Yok", count: 1 },
  ],
  productRows: [
    {
      productId: "product-1",
      productName: "Eksik SKU Ürünü",
      imageLabel: "ES",
      updatedAt: "2026-07-17T08:00:00.000Z",
      mistakes: ["SKU Eksik", "Aynı SKU"],
      actionLabel: "İncele",
    },
    {
      productId: "product-2",
      productName: "Stoksuz Ürün",
      imageLabel: "ST",
      updatedAt: "2026-07-16T08:00:00.000Z",
      mistakes: ["Stokta Yok"],
      actionLabel: "İncele",
    },
  ],
  issues: [],
};

function snapshotAt(generatedAt: string): ScanSnapshot {
  return {
    version: 1,
    scanId: "scan-1",
    authorizedAppId: installation.authorizedAppId,
    merchantId: installation.merchantId,
    generatedAt,
    report: { ...report, generatedAt },
  };
}

const staleSnapshot = snapshotAt("2026-07-18T08:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(installation);
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.getIkasToken.mockResolvedValue(storedToken);
  mocks.getLatestSnapshot.mockResolvedValue(staleSnapshot);
  mocks.getIkasLaunchAuthenticationHref.mockReturnValue(undefined);
  mocks.listProducts.mockResolvedValue({ source: "http", products: [] });
});

async function renderHome(searchParams: Record<string, string> = {}) {
  const element = await Home({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}

describe("dashboard reads the stored snapshot without scanning", () => {
  it("renders the snapshot report and makes zero ikas catalog calls", async () => {
    const html = await renderHome();

    expect(html).toContain("31 (121)");
    expect(html).toContain("82/100");
    expect(html).toContain("Mağaza: dev-emre2");
    expect(html).toContain('href="/api/report.csv"');
    expect(html).toContain("https://dev-emre2.myikas.com/admin/product/edit/product-1");
    expect(mocks.getLatestSnapshot).toHaveBeenCalledWith({
      authorizedAppId: "app-1",
      merchantId: "merchant-1",
    });
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("makes zero ikas catalog calls when the rule filter changes", async () => {
    await renderHome();
    await renderHome({ rule: "missing_sku" });
    await renderHome({ rule: "out_of_stock" });
    await renderHome({});

    expect(mocks.getLatestSnapshot).toHaveBeenCalledTimes(4);
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("filters product rows by the selected rule from the same snapshot", async () => {
    const html = await renderHome({ rule: "missing_sku" });

    expect(html).toContain("SKU Eksik filtresi açık.");
    expect(html).toContain("Eksik SKU Ürünü");
    expect(html).not.toContain("Stoksuz Ürün");
    expect(html).toContain('href="/?rule=missing_sku"');
    expect(html).toContain('aria-label="Kural filtresi"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="SKU Eksik, 1 ürün"');
    expect(html).toContain("Filtreyi temizle");
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("does not render a clear-filter action when no rule is selected", async () => {
    const html = await renderHome();

    expect(html).not.toContain("Filtreyi temizle");
  });

  it("keeps the product action reachable in a horizontally scrollable table", async () => {
    const html = await renderHome();

    expect(html).toContain("overflow-x-auto");
    expect(html).not.toContain("overflow-hidden rounded-2xl");
  });
});

describe("scan freshness and the manual scan action", () => {
  it("shows the snapshot timestamp as machine-readable scan identity", async () => {
    const html = await renderHome();

    expect(html).toContain("Son tarama");
    expect(html).toContain('dateTime="2026-07-18T08:00:00.000Z"');
  });

  it("offers a manual scan as an explicit tenant-bound POST, never a navigation link", async () => {
    const html = await renderHome();

    expect(html).toContain('action="/api/scans"');
    expect(html).toContain('method="post"');
    expect(html).toContain("Şimdi tara");
    expect(html).not.toContain('href="/api/scans"');
    // The tenant is resolved server-side; nothing tenant-identifying is posted.
    expect(html).not.toContain("app-1");
    expect(html).not.toContain("merchant-1");
  });

  it("warns that an old snapshot may be out of date", async () => {
    const html = await renderHome();

    expect(html).toContain("güncelliğini yitirmiş olabilir");
  });

  it("does not call a fresh snapshot stale", async () => {
    mocks.getLatestSnapshot.mockResolvedValue(snapshotAt(new Date().toISOString()));

    const html = await renderHome();

    expect(html).not.toContain("güncelliğini yitirmiş olabilir");
  });
});

describe("first-scan state", () => {
  it("asks for an explicit first scan instead of silently scanning on render", async () => {
    mocks.getLatestSnapshot.mockResolvedValue(undefined);

    const html = await renderHome();

    expect(html).toContain("Henüz tarama yapılmadı");
    expect(html).toContain('action="/api/scans"');
    expect(html).toContain("Şimdi tara");
    expect(html).not.toContain("82/100");
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("does not offer a CSV export before the first scan", async () => {
    mocks.getLatestSnapshot.mockResolvedValue(undefined);

    const html = await renderHome();

    expect(html).not.toContain('href="/api/report.csv"');
  });
});

describe("scan outcome feedback", () => {
  it("confirms a completed scan", async () => {
    const html = await renderHome({ scan: "completed" });

    expect(html).toContain("Tarama tamamlandı");
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("explains that a duplicate scan is already running", async () => {
    const html = await renderHome({ scan: "busy" });

    expect(html).toContain("Bu mağaza için bir tarama zaten sürüyor");
  });

  it("keeps the previous successful report visible after a scan-limit failure", async () => {
    const html = await renderHome({ scan: "limit" });

    expect(html).toContain("güvenli sınırlarını aştı");
    expect(html).toContain("son başarılı taramadan geliyor");
    // The failed scan must not have replaced the readable report.
    expect(html).toContain("82/100");
    expect(html).toContain("Eksik SKU Ürünü");
  });

  it("keeps the previous successful report visible after a generic scan failure", async () => {
    const html = await renderHome({ scan: "failed" });

    expect(html).toContain("Tarama tamamlanamadı");
    expect(html).toContain("82/100");
  });

  it("does not claim a previous report exists when the first scan fails", async () => {
    mocks.getLatestSnapshot.mockResolvedValue(undefined);

    const html = await renderHome({ scan: "failed" });

    expect(html).toContain("Tarama tamamlanamadı");
    expect(html).not.toContain("son başarılı taramadan geliyor");
    expect(html).toContain("Henüz tarama yapılmadı");
  });

  it("ignores an unrecognised scan status value", async () => {
    const html = await renderHome({ scan: "<script>alert(1)</script>" });

    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("Tarama tamamlandı");
  });
});

describe("tenant-bound access control", () => {
  it("renders the setup-required screen without reading a snapshot", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const html = await renderHome();

    expect(html).toContain("ikas ile güvenli şekilde bağlan");
    expect(html).toContain('href="/authorize-store"');
    expect(html.match(/href="\/authorize-store"/g)).toHaveLength(1);
    expect(html).toContain("Ürün veya stok bilgileri değiştirilmez");
    expect(html).toContain("bg-slate-50");
    expect(html).not.toContain("MVP");
    expect(html).not.toContain("ilk sürüm");
    expect(mocks.getLatestSnapshot).not.toHaveBeenCalled();
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("asks the merchant to reconnect when the durable token no longer matches the session", async () => {
    mocks.getIkasToken.mockResolvedValue(undefined);

    const html = await renderHome();

    expect(html).toContain("Mağaza bağlantısını yenile");
    expect(mocks.getLatestSnapshot).not.toHaveBeenCalled();
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("refuses to render another tenant's snapshot", async () => {
    mocks.getIkasToken.mockResolvedValue({ ...storedToken, merchantId: "merchant-2" });

    const html = await renderHome();

    expect(html).toContain("Mağaza bağlantısını yenile");
    expect(html).not.toContain("82/100");
    expect(mocks.getLatestSnapshot).not.toHaveBeenCalled();
  });
});

describe("paid-feature interest", () => {
  it("submits interest through a tenant-bound POST instead of a mailto link", async () => {
    const html = await renderHome();

    expect(html).toContain('action="/api/interest"');
    expect(html).toContain('value="low_stock_threshold_monitoring"');
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("app-1");
    expect(html).not.toContain("merchant-1");
  });

  it("describes threshold monitoring as planned instead of selling the zero-stock count", async () => {
    const html = await renderHome();

    expect(html).toContain("stok dışı satış kapalı");
    expect(html).toContain("Planlanan ücretli özellik");
    expect(html).not.toContain("stok riski bulundu");
  });

  it("shows a safe thank-you status after the interest redirect", async () => {
    const html = await renderHome({ interest: "recorded" });

    expect(html).toContain("İlginizi kaydettik");
    expect(html).not.toContain('action="/api/interest"');
  });

  it("ignores an unrecognised interest status value", async () => {
    const html = await renderHome({ interest: "<script>alert(1)</script>" });

    expect(html).not.toContain("İlginizi kaydettik");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain('action="/api/interest"');
  });

  it("does not expose internal prototype language on the dashboard", async () => {
    const html = await renderHome();

    expect(html).not.toContain("MVP");
    expect(html).not.toContain("ilk sürüm");
    expect(html).not.toContain("Ücretli MVP sinyali");
    expect(html).not.toContain("☆☆☆☆☆");
  });
});
