import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@/lib/ikas/types";
import { SnapshotStoreError, type ScanSnapshot } from "@/lib/scans/snapshot-store";

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
  hasActiveScanLease: vi.fn(),
  getIkasToken: vi.fn(),
  resolveInstallationRetentionPolicy: vi.fn(),
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
  hasActiveScanLease: mocks.hasActiveScanLease,
}));

vi.mock("@/lib/billing/runtime-entitlement", () => ({
  resolveInstallationRetentionPolicy: mocks.resolveInstallationRetentionPolicy,
}));

vi.mock("@/lib/ikas/token-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ikas/token-store")>()),
  getIkasToken: mocks.getIkasToken,
}));

// Partial: the scan service reads the real scan-duration budget to size its lease TTL, while
// the adapter class stays a spy so any catalog call would be observed rather than performed.
vi.mock("@/lib/ikas/product-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ikas/product-adapter")>()),
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
    low_stock: 0,
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
  issues: [
    {
      code: "missing_sku",
      severity: "critical",
      productId: "product-1",
      productName: "Eksik SKU Ürünü",
      message: "Aktif varyantta SKU eksik.",
    },
    {
      code: "duplicate_sku",
      severity: "critical",
      productId: "product-1",
      productName: "Eksik SKU Ürünü",
      message: "SKU başka aktif varyantlarda da kullanılıyor.",
    },
    {
      code: "zero_stock_blocked",
      severity: "critical",
      productId: "product-2",
      productName: "Stoksuz Ürün",
      message: "Varyant stokta yok ve stok dışı satış kapalı.",
    },
    {
      code: "missing_barcode",
      severity: "critical",
      productId: "product-2",
      productName: "Stoksuz Ürün",
      message: "Aktif varyantta barkod yok.",
    },
  ],
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
  mocks.hasActiveScanLease.mockResolvedValue(false);
  mocks.getIkasLaunchAuthenticationHref.mockReturnValue(undefined);
  mocks.listProducts.mockResolvedValue({ source: "http", products: [] });
});

async function renderHome(searchParams: Record<string, string> = {}) {
  const element = await Home({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}

describe("dashboard reads the stored snapshot without scanning", () => {
  it("composes header, health summary, filters and table from one snapshot", async () => {
    const html = await renderHome();

    expect(html).toContain("Ürün Sağlığı");
    expect(html).toContain("dev-emre2");
    expect(html).toContain("Sağlık durumu");
    expect(html).toContain("Kritik sorun");
    expect(html).toContain("Sorunlu ürünler");
    expect(html).toContain('href="/api/report.csv"');
    expect(html).toContain("https://dev-emre2.myikas.com/admin/product/edit/product-1");
    expect(mocks.getLatestSnapshot).toHaveBeenCalledWith({
      authorizedAppId: "app-1",
      merchantId: "merchant-1",
    });
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("makes zero ikas catalog calls for any filter, search, sort or page navigation", async () => {
    await renderHome();
    await renderHome({ rule: "missing_sku" });
    await renderHome({ rule: "out_of_stock" });
    await renderHome({ q: "stoksuz" });
    await renderHome({ sort: "name" });
    await renderHome({ page: "2" });
    await renderHome({});

    expect(mocks.getLatestSnapshot).toHaveBeenCalledTimes(7);
    expect(mocks.resolveInstallationRetentionPolicy).not.toHaveBeenCalled();
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("filters product rows by the selected rule from the same snapshot", async () => {
    const html = await renderHome({ rule: "missing_sku" });

    expect(html).toContain("Filtre: SKU Eksik");
    expect(html).toContain("Eksik SKU Ürünü");
    expect(html).not.toContain("Stoksuz Ürün");
    expect(html).toContain('href="/?rule=missing_sku"');
    expect(html).toContain('aria-label="Kural filtresi"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="SKU Eksik, 1 ürün, seçili filtre"');
    expect(html).toContain("Filtreyi temizle");
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("does not render a clear-filter action when no rule is selected", async () => {
    const html = await renderHome();

    expect(html).not.toContain("Filtreyi temizle");
  });

  it("narrows the table by the search term in the URL", async () => {
    const html = await renderHome({ q: "stoksuz" });

    expect(html).toContain("Stoksuz Ürün");
    expect(html).not.toContain("Eksik SKU Ürünü");
    expect(html).toContain("Aramayı temizle");
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("combines the rule filter and the search term", async () => {
    const html = await renderHome({ rule: "missing_sku", q: "stoksuz" });

    expect(html).toContain("aramasıyla eşleşen ürün yok");
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("preserves the active rule while sorting", async () => {
    const html = await renderHome({ rule: "missing_sku", sort: "name" });

    expect(html).toContain("Sıralama: Ürün adı");
    expect(html).toContain('href="/?rule=missing_sku&amp;sort=updated"');
  });

  it("keeps the product table reachable in a horizontally scrollable region", async () => {
    const html = await renderHome();

    expect(html).toContain("overflow-x-auto");
    expect(html).not.toContain("overflow-hidden");
    expect(html).toContain("yatay kaydır");
  });
});

describe("health summary replaces the oversized KPI cards", () => {
  it("shows a size-comparable score with its state in words", async () => {
    const html = await renderHome();

    // 4 critical issues over 31 products is 0.9 weighted points per product.
    expect(html).toContain("95");
    expect(html).toContain("/100");
    expect(html).toContain("İyi durumda");
  });

  it("no longer shows the un-normalized stored score", async () => {
    const html = await renderHome();

    expect(html).not.toContain("82/100");
  });

  it("publishes how the score is produced", async () => {
    const html = await renderHome();

    expect(html).toContain("Skor nasıl hesaplanır?");
    expect(html).toContain("gerçek mağazalardan ölçülmüş bir dağılıma değil");
  });

  it("shows no change-since-last-scan, because only the latest snapshot is stored", async () => {
    const html = await renderHome();

    for (const trend of ["Önceki tarama", "geçen taramaya göre", "▲", "▼"]) {
      expect(html).not.toContain(trend);
    }
  });

  it("scores a store with no products as unscoreable rather than perfect", async () => {
    mocks.getLatestSnapshot.mockResolvedValue({
      ...staleSnapshot,
      report: {
        ...report,
        productCount: 0,
        variantCount: 0,
        affectedProductCount: 0,
        criticalCount: 0,
        issueCount: 0,
        issues: [],
        productRows: [],
        generatedAt: staleSnapshot.generatedAt,
      },
    });

    const html = await renderHome();

    expect(html).toContain("Taranacak ürün yok");
    expect(html).not.toContain("100/100");
    expect(html).toContain("Mağazanızda taranacak ürün bulunamadı");
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

  it("blocks a second scan submission while one is already running", async () => {
    const html = await renderHome({ scan: "busy" });

    expect(html).toContain('disabled=""');
    expect(html).toContain("Tarama sürüyor");
  });

  /**
   * `?scan=busy` only survives one redirect: reload the dashboard and it is gone, so a button
   * disabled by that alone goes live again while the scan is still running. The real state
   * lives in the Redis lease, and that is what the control has to derive from.
   */
  it("blocks the scan action on a fresh load while the lease is actually held", async () => {
    mocks.hasActiveScanLease.mockResolvedValue(true);

    const html = await renderHome();

    expect(html).toContain('disabled=""');
    expect(html).toContain("Tarama sürüyor");
    expect(html).not.toContain("Şimdi tara");
  });

  it("reads the lease for the session tenant only, never a URL-supplied one", async () => {
    await renderHome({ authorizedAppId: "attacker-app", merchantId: "attacker-merchant" });

    expect(mocks.hasActiveScanLease).toHaveBeenCalledWith({
      authorizedAppId: "app-1",
      merchantId: "merchant-1",
    });
  });

  it("answers the lease question from Redis alone, never from the ikas catalog", async () => {
    mocks.hasActiveScanLease.mockResolvedValue(true);

    await renderHome();

    expect(mocks.hasActiveScanLease).toHaveBeenCalledOnce();
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("keeps the scan action live when no lease is held", async () => {
    const html = await renderHome();

    expect(html).toContain("Şimdi tara");
    expect(html).not.toContain('disabled=""');
  });

  it("still renders the dashboard when the lease store cannot be reached", async () => {
    mocks.hasActiveScanLease.mockRejectedValue(new SnapshotStoreError("backend", "lease"));

    const html = await renderHome();

    // The server-side 409 remains the authoritative duplicate-scan guard, so an unreadable
    // lease degrades to a live button rather than an unrenderable page.
    expect(html).toContain("Şimdi tara");
    expect(html).toContain("Sorunlu ürünler");
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
    expect(html).not.toContain("/100");
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("does not offer a CSV export before the first scan", async () => {
    mocks.getLatestSnapshot.mockResolvedValue(undefined);

    const html = await renderHome();

    expect(html).not.toContain('href="/api/report.csv"');
  });

  it("disables the first scan while that first scan is already running", async () => {
    mocks.getLatestSnapshot.mockResolvedValue(undefined);
    mocks.hasActiveScanLease.mockResolvedValue(true);

    const html = await renderHome();

    expect(html).toContain('disabled=""');
    expect(html).toContain("Tarama sürüyor");
    expect(html).not.toContain("Şimdi tara");
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
    expect(html).toContain("Eksik SKU Ürünü");
  });

  it("keeps the previous successful report visible after a generic scan failure", async () => {
    const html = await renderHome({ scan: "failed" });

    expect(html).toContain("Tarama tamamlanamadı");
    expect(html).toContain("Eksik SKU Ürünü");
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

describe("URL input is validated rather than trusted", () => {
  it("ignores an unknown rule, sort and page instead of rendering them", async () => {
    const html = await renderHome({ rule: "../secret", sort: "'; DROP", page: "-3" });

    expect(html).not.toContain("../secret");
    expect(html).not.toContain("DROP");
    expect(html).toContain("Tüm sorunlu ürünler gösteriliyor");
    expect(html).toContain("Eksik SKU Ürünü");
  });

  it("escapes a hostile search term instead of executing it", async () => {
    const html = await renderHome({ q: "<script>alert(1)</script>" });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("aramasıyla eşleşen ürün yok");
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
    expect(html).toContain("bg-canvas");
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
    expect(html).not.toContain("Sorunlu ürünler");
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

  /**
   * The count beside this section is the hard blocked-sale count the scan measures. Threshold
   * tracking is not running, so the copy has to say that in a merchant's words without either
   * implying the threshold is already watched or reading like an internal roadmap entry.
   */
  it("states plainly what the count is and that threshold tracking is not running yet", async () => {
    const html = await renderHome();

    expect(html).toContain("stok dışı satış kapalı");
    expect(html).toContain("Düşük stok uyarısı henüz kullanılamıyor");
    // The count is the blocked-sale count, and the copy has to say which one it is not.
    expect(html).toContain("belirlediğiniz bir stok eşiğine göre değil");
    expect(html).toContain("stoğu tamamen bitmiş");
    expect(html).not.toContain("stok riski bulundu");
  });

  it("keeps the read-only promise on this section in customer-facing words", async () => {
    const html = await renderHome();

    expect(html).toContain("Stok ve ürün bilgileriniz değiştirilmez");
  });

  it("uses no internal roadmap language to describe the feature", async () => {
    const html = await renderHome();

    for (const phrase of ["Planlanan ücretli özellik", "V1", "roadmap", "yol haritası", "faz"]) {
      expect(html).not.toContain(phrase);
    }
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

describe("the dashboard uses the shared design system", () => {
  it("references semantic tokens rather than ad-hoc palette steps", async () => {
    const html = await renderHome();

    expect(html).not.toMatch(/(slate|orange|violet|emerald|amber)-\d{2,3}/);
  });
});
