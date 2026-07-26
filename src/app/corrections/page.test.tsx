import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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

async function render() {
  return renderToStaticMarkup(await CorrectionsPage());
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
