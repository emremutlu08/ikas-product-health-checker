import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsAccessError } from "@/lib/settings/settings-service";
import { MonitoringSettingsStoreError } from "@/lib/settings/settings-store";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  readMonitoringSettings: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/settings/settings-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/settings-service")>()),
  readMonitoringSettings: mocks.readMonitoringSettings,
}));

vi.mock("@/components/IkasAppBridgeReady", () => ({ IkasAppBridgeReady: () => null }));

import SettingsPage from "./page";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(installation);
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.readMonitoringSettings.mockResolvedValue({
    tier: "pro",
    settings: { lowStockThreshold: 12, dailyEmailEnabled: true },
  });
});

async function renderPage(searchParams?: Record<string, string>) {
  return renderToStaticMarkup(
    await SettingsPage({ searchParams: Promise.resolve(searchParams ?? {}) }),
  );
}

describe("settings page", () => {
  it("requires an installation without calling the Pro boundary", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const html = await renderPage();

    expect(html).toContain("ikas mağazanızla açın");
    expect(mocks.readMonitoringSettings).not.toHaveBeenCalled();
  });

  it("shows a truthful Pro-required state without guessing Free or inventing a purchase link", async () => {
    mocks.readMonitoringSettings.mockRejectedValue(new SettingsAccessError());

    const html = await renderPage();

    expect(html).toContain("Pro");
    expect(html).not.toContain("Mevcut planınız Free");
    expect(html).not.toContain("Satın al");
    expect(html).not.toContain('action="/api/settings"');
  });

  it("shows a recoverable state when the settings backend is unavailable", async () => {
    mocks.readMonitoringSettings.mockRejectedValue(new MonitoringSettingsStoreError("backend", "get"));

    const html = await renderPage();

    expect(html).toContain("şu anda yüklenemiyor");
    expect(html).not.toContain("IKAS_SETTINGS_STORE_BACKEND");
  });

  it("renders native, pre-filled, keyboard-focusable controls posting to the settings API", async () => {
    const html = await renderPage();

    expect(html).toContain('action="/api/settings"');
    expect(html).toContain('method="post"');
    expect(html).toContain('type="number"');
    expect(html).toContain('name="lowStockThreshold"');
    expect(html).toContain('value="12"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="1000"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="dailyEmailEnabled"');
    expect(html).toContain("checked");
    // A label is associated with each control for keyboard and screen-reader users.
    expect(html).toContain('for="lowStockThreshold"');
    expect(html).toContain('for="dailyEmailEnabled"');
  });

  it("does not pre-check the email box when the summary is disabled", async () => {
    mocks.readMonitoringSettings.mockResolvedValue({
      tier: "pro",
      settings: { lowStockThreshold: 0, dailyEmailEnabled: false },
    });

    const html = await renderPage();

    expect(html).toContain('value="0"');
    expect(html).not.toContain("checked");
  });

  it("confirms a saved submission and flags a rejected one from the status param", async () => {
    expect(await renderPage({ status: "saved" })).toContain("kaydedildi");
    expect(await renderPage({ status: "invalid" })).toContain("kaydedilemedi");
  });

  it("links back to the dashboard and never renders sealed tenant identifiers", async () => {
    const html = await renderPage();

    expect(html).toContain('href="/"');
    expect(html).not.toContain(installation.authorizedAppId);
    expect(html).not.toContain(installation.merchantId);
    expect(mocks.readMonitoringSettings).toHaveBeenCalledWith(installation);
  });
});
