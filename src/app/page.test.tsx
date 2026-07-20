import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@/lib/ikas/types";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  getProductHealthReport: vi.fn(),
  getIkasLaunchAuthenticationHref: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/ikas/report-service", () => ({
  getProductHealthReport: mocks.getProductHealthReport,
}));

vi.mock("@/lib/ikas/installation-auth", () => ({
  getIkasLaunchAuthenticationHref: mocks.getIkasLaunchAuthenticationHref,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(installation);
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.getProductHealthReport.mockResolvedValue({ source: "http", report });
  mocks.getIkasLaunchAuthenticationHref.mockReturnValue(undefined);
});

async function renderHome(searchParams: Record<string, string> = {}) {
  const element = await Home({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}

describe("authenticated product health dashboard", () => {
  it("renders live summary metrics and tenant-safe report actions", async () => {
    const html = await renderHome();

    expect(html).toContain("31 (121)");
    expect(html).toContain("82/100");
    expect(html).toContain("Mağaza: dev-emre2");
    expect(html).toContain('href="/api/report.csv"');
    expect(html).not.toContain("authorizedAppId=");
    expect(html).toContain("https://dev-emre2.myikas.com/admin/product/edit/product-1");
    expect(mocks.getProductHealthReport).toHaveBeenCalledWith(expect.any(Date), installation);
  });

  it("filters product rows by the selected rule", async () => {
    const html = await renderHome({ rule: "missing_sku" });

    expect(html).toContain("SKU Eksik filtresi açık.");
    expect(html).toContain("Eksik SKU Ürünü");
    expect(html).not.toContain("Stoksuz Ürün");
    expect(html).toContain('href="/?rule=missing_sku"');
  });

  it("submits paid-feature interest through a tenant-bound POST instead of a mailto link", async () => {
    const html = await renderHome();

    expect(html).toContain('action="/api/interest"');
    expect(html).toContain('method="post"');
    expect(html).toContain('value="low_stock_threshold_monitoring"');
    expect(html).not.toContain("mailto:");
    // The tenant is resolved server-side from the session, never posted by the client.
    expect(html).not.toContain("app-1");
    expect(html).not.toContain("merchant-1");
  });

  it("describes threshold monitoring as planned instead of selling the zero-stock count as a low-stock result", async () => {
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

  it("renders the setup-required screen without consulting live report data", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const html = await renderHome();

    expect(html).toContain("Kurulumu tamamla");
    expect(html).toContain('href="/authorize-store"');
    expect(mocks.getProductHealthReport).not.toHaveBeenCalled();
  });
});
