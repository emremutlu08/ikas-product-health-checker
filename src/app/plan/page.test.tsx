import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  resolveInstallationEntitlement: vi.fn(),
  resolveRolloutSignals: vi.fn(),
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

vi.mock("@/components/IkasAppBridgeReady", () => ({ IkasAppBridgeReady: () => null }));

import PlanPage from "./page";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
};

const closedSignals = {
  productWritesEnabled: false,
  bulkWritesEnabled: false,
  schedulerEnabled: false,
  emailDeliveryConfigured: false,
  verifiedRecipientConfigured: false,
};

async function render() {
  return renderToStaticMarkup(await PlanPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(installation);
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.resolveInstallationEntitlement.mockResolvedValue({
    authorizedAppId: "app-1",
    merchantId: "merchant-1",
    tier: "pro",
    state: "active",
    reason: "ACTIVE_KNOWN_PLAN",
  });
  mocks.resolveRolloutSignals.mockReturnValue(closedSignals);
});

describe("plan page", () => {
  it("shows the comparison built from the live entitlement and the real rollout state", async () => {
    const html = await render();

    expect(html).toContain("Free ve PRO karşılaştırması");
    expect(html).toContain("Mevcut planınız: PRO.");
    expect(html).toContain("Geliştirme mağazasıyla sınırlı");
    expect(mocks.resolveInstallationEntitlement).toHaveBeenCalledWith(installation);
    expect(mocks.resolveRolloutSignals).toHaveBeenCalledWith(installation);
  });

  it("falls back to Free when the licence cannot be read", async () => {
    mocks.resolveInstallationEntitlement.mockResolvedValue({
      authorizedAppId: "app-1",
      merchantId: null,
      tier: "free",
      state: "unknown",
      reason: "LICENCE_UNAVAILABLE",
    });

    const html = await render();

    expect(html).toContain("Plan bilgisi şu anda doğrulanamadı");
  });

  it("requires a sealed installation session and never resolves a licence without one", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const html = await render();

    expect(html).toContain("Plan bilgisi açılamadı");
    expect(mocks.resolveInstallationEntitlement).not.toHaveBeenCalled();
  });

  it("keeps the merchant able to navigate back to every other surface", async () => {
    const html = await render();

    for (const href of ["/", "/history", "/settings", "/plan"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('aria-current="page"');
  });

  it("paints on the shared semantic tokens rather than raw palette steps", async () => {
    const html = await render();

    expect(html).toContain("bg-canvas");
    expect(html).toContain("bg-surface");
    expect(html).not.toMatch(/bg-(gray|slate|zinc|neutral|stone)-\d/);
  });
});
