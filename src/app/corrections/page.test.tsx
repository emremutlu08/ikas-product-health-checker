import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  panelProps: [] as Record<string, unknown>[],
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  resolveInstallationEntitlement: vi.fn(),
  resolveRolloutSignals: vi.fn(),
  getLatestProductHealthReport: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/billing/runtime-entitlement", () => ({
  resolveInstallationEntitlement: mocks.resolveInstallationEntitlement,
}));

vi.mock("@/lib/billing/rollout-signals", () => ({
  resolveRolloutSignals: mocks.resolveRolloutSignals,
}));

vi.mock("@/lib/ikas/report-service", () => ({
  getLatestProductHealthReport: mocks.getLatestProductHealthReport,
}));

vi.mock("@/components/IkasAppBridgeReady", () => ({ IkasAppBridgeReady: () => null }));

/**
 * Wraps the real panel so a test can inspect exactly what crossed the server-to-client boundary,
 * while everything else still renders the genuine component.
 */
vi.mock("@/components/CorrectionPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/CorrectionPanel")>();
  return {
    ...actual,
    CorrectionPanel: (props: Record<string, unknown>) => {
      mocks.panelProps.push(props);
      return actual.CorrectionPanel(props as never);
    },
  };
});

import CorrectionsPage from "./page";

const installation = { authorizedAppId: "app-1", merchantId: "merchant-1", storeName: "dev-emre2" };

const signals = {
  productWritesEnabled: false,
  bulkWritesEnabled: false,
  schedulerEnabled: false,
  emailDeliveryConfigured: false,
  verifiedRecipientConfigured: false,
};

const snapshot = {
  source: "snapshot",
  stale: false,
  snapshot: {
    report: {
      // Present because production always stores it, and the correction screen reads its images
      // from here rather than fetching the catalog again.
      productRows: [
        {
          productId: "product-1",
          productName: "Classic Laptop Sleeve",
          imageLabel: "CL",
          imageSrc: "https://cdn.example.test/product-1.webp",
          mistakes: ["SKU Eksik"],
          actionLabel: "İncele",
        },
      ],
      issues: [
        {
          code: "missing_sku",
          severity: "critical",
          productId: "product-1",
          productName: "Classic Laptop Sleeve",
          variantId: "variant-1",
          message: "Aktif varyantta SKU eksik.",
        },
        {
          code: "missing_description",
          severity: "warning",
          productId: "product-1",
          productName: "Classic Laptop Sleeve",
          message: "Üründe açıklama yok.",
        },
      ],
    },
  },
};

async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await CorrectionsPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(installation);
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.resolveInstallationEntitlement.mockResolvedValue({ tier: "pro", state: "active" });
  mocks.resolveRolloutSignals.mockReturnValue(signals);
  mocks.getLatestProductHealthReport.mockResolvedValue(snapshot);
});

describe("corrections page", () => {
  it("offers no control at all while the write surface is development-store limited", async () => {
    const html = await render();

    expect(html).toContain("Geliştirme mağazasıyla sınırlı");
    expect(html).toContain("kataloğunuzda hiçbir değişiklik yapılamaz");
    expect(html).not.toContain("Önizle");
    expect(html).not.toContain("<input");
    // The snapshot is not even read when nothing could be confirmed.
    expect(mocks.getLatestProductHealthReport).not.toHaveBeenCalled();
  });

  it("tells a Free merchant this is a PRO capability rather than showing a dead control", async () => {
    mocks.resolveInstallationEntitlement.mockResolvedValue({ tier: "free", state: "active" });

    const html = await render();

    expect(html).toContain("PRO paketine dahildir");
    expect(html).not.toContain("Önizle");
  });

  it("renders only the issues a correction can actually fix once the flag is open", async () => {
    mocks.resolveRolloutSignals.mockReturnValue({ ...signals, productWritesEnabled: true });

    const html = await render();

    expect(html).toContain("Classic Laptop Sleeve");
    expect(html).toContain("Yeni SKU");
    expect(html).toContain("Önizle");
    // A description problem is not correctable, so it is not offered.
    expect(html).not.toContain("Üründe açıklama yok.");
  });

  /**
   * A correction list without pictures is a wall of near-identical variant names — "Basic Cap —
   * Varyant 1" through 24 — and picking the wrong one writes to the wrong variant. The image is
   * taken from the stored scan, so showing it costs no extra catalog read.
   */
  it("shows the product image the scan already resolved", async () => {
    mocks.resolveRolloutSignals.mockReturnValue({ ...signals, productWritesEnabled: true });

    const html = await render();

    expect(html).toContain("https://cdn.example.test/product-1.webp");
  });

  /**
   * Search and pagination are resolved before anything is rendered, so a large catalog sends one
   * page of work over the wire instead of every correctable variant it happens to have.
   */
  it("filters on the server rather than shipping everything for the browser to hide", async () => {
    mocks.resolveRolloutSignals.mockReturnValue({ ...signals, productWritesEnabled: true });

    const matched = await render({ q: "classic" });
    expect(matched).toContain("Classic Laptop Sleeve");

    const missed = await render({ q: "bulunmayan ürün" });
    expect(missed).not.toContain("Classic Laptop Sleeve");
    expect(missed).toContain("Aramanızla eşleşen düzeltme yok.");
  });

  it("keeps the search in the URL so a filtered view can be reloaded and linked", async () => {
    mocks.resolveRolloutSignals.mockReturnValue({ ...signals, productWritesEnabled: true });

    const html = await render({ q: "classic" });

    expect(html).toContain('value="classic"');
    expect(html).toContain('action="/corrections"');
  });

  /**
   * `CorrectionPanel` is a client component, and React refuses to serialize a function across that
   * boundary — it renders the entire screen as an error instead. Every test here rendered fine
   * while production was broken, because `renderToStaticMarkup` does not enforce that rule. This
   * asserts the contract the runtime enforces rather than the one the test renderer does.
   */
  it("hands the client component only serializable props", async () => {
    mocks.resolveRolloutSignals.mockReturnValue({ ...signals, productWritesEnabled: true });
    mocks.panelProps.length = 0;

    await render({ q: "classic", page: "2" });

    expect(mocks.panelProps).toHaveLength(1);
    const offending = Object.entries(mocks.panelProps[0]!).filter(
      ([, value]) => typeof value === "function",
    );
    expect(offending.map(([name]) => name)).toEqual([]);
    // Structured-clone is the actual serialization boundary, so failing it here is failing there.
    expect(() => structuredClone(mocks.panelProps[0])).not.toThrow();
  });

  it("states the safety contract on the page itself", async () => {
    mocks.resolveRolloutSignals.mockReturnValue({ ...signals, productWritesEnabled: true });

    const html = await render();

    expect(html).toContain("yalnızca");
    expect(html).toContain("açık onayınızdan sonra uygulanır");
    expect(html).toContain("yeniden okunarak doğrulanır");
  });

  it("asks for a scan first when there is no snapshot", async () => {
    mocks.resolveRolloutSignals.mockReturnValue({ ...signals, productWritesEnabled: true });
    mocks.getLatestProductHealthReport.mockResolvedValue({ source: "none" });

    expect(await render()).toContain("Henüz tarama yapılmadı");
  });

  it("requires a sealed installation session before resolving anything", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const html = await render();

    expect(html).toContain("Düzeltmeler açılamadı");
    expect(mocks.resolveInstallationEntitlement).not.toHaveBeenCalled();
  });
});
