import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsAccessError } from "@/lib/settings/settings-service";
import { MonitoringSettingsStoreError } from "@/lib/settings/settings-store";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  readMonitoringSettings: vi.fn(),
  resolveVerifiedRecipient: vi.fn(),
  isDailySummaryEmailConfigured: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/settings/settings-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/settings-service")>()),
  readMonitoringSettings: mocks.readMonitoringSettings,
}));

vi.mock("@/lib/monitoring/verified-recipient", () => ({
  resolveVerifiedRecipient: mocks.resolveVerifiedRecipient,
}));

vi.mock("@/lib/monitoring/email-summary", () => ({
  isDailySummaryEmailConfigured: mocks.isDailySummaryEmailConfigured,
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
  vi.stubEnv("IKAS_MONITORING_SCHEDULER_ENABLED", "true");
  mocks.getSession.mockResolvedValue(installation);
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.readMonitoringSettings.mockResolvedValue({
    tier: "pro",
    settings: { lowStockThreshold: 12, dailyEmailEnabled: true },
  });
  mocks.resolveVerifiedRecipient.mockReturnValue({ email: "owner@example.com" });
  mocks.isDailySummaryEmailConfigured.mockReturnValue(true);
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
    expect(html).toContain('aria-describedby="lowStockThreshold-help"');
    expect(html).toContain('aria-describedby="dailyEmailEnabled-help"');
    expect(html).toContain("Stok adedi 1 ile bu değer arasında olan aktif varyantlar");
    expect(html).toContain("o***r@example.com");
    expect(html).toContain("Otomatik tarama hazır");
    expect(html).toContain("E-posta gönderimi hazır");
  });

  it("blocks email activation when the recipient or scheduler is not ready", async () => {
    mocks.readMonitoringSettings.mockResolvedValue({
      tier: "pro",
      settings: { lowStockThreshold: 12, dailyEmailEnabled: false },
    });
    mocks.resolveVerifiedRecipient.mockReturnValue(undefined);
    vi.stubEnv("IKAS_MONITORING_SCHEDULER_ENABLED", "false");

    const html = await renderPage();

    expect(html).toContain("Doğrulanmış e-posta alıcısı yapılandırılmamış");
    expect(html).toContain("Otomatik tarama henüz etkin değil");
    expect(html).toContain('disabled=""');
  });

  it("blocks email activation when provider delivery configuration is invalid", async () => {
    mocks.readMonitoringSettings.mockResolvedValue({
      tier: "pro",
      settings: { lowStockThreshold: 12, dailyEmailEnabled: false },
    });
    mocks.isDailySummaryEmailConfigured.mockReturnValue(false);

    const html = await renderPage();

    expect(html).toContain("E-posta gönderimi henüz hazır değil");
    expect(html).toContain('disabled=""');
  });

  it("keeps an existing email setting editable when delivery becomes temporarily unready", async () => {
    mocks.isDailySummaryEmailConfigured.mockReturnValue(false);

    const html = await renderPage();

    expect(html).toContain("Mevcut e-posta ayarı açık kalır");
    expect(html).toContain("checked");
    expect(html).not.toContain('disabled=""');
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

  it("confirms saved, invalid, and unavailable submission states accessibly", async () => {
    expect(await renderPage({ status: "saved" })).toContain("kaydedildi");
    expect(await renderPage({ status: "invalid" })).toContain("kaydedilemedi");
    const unavailable = await renderPage({ status: "unavailable" });
    expect(unavailable).toContain('role="alert"');
    expect(unavailable).toContain("etkinleştirilemedi");
  });

  it("links back to the dashboard and never renders sealed tenant identifiers", async () => {
    const html = await renderPage();

    expect(html).toContain('href="/"');
    expect(html).toContain('href="/history"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('aria-label="Ana navigasyon"');
    expect(html).not.toContain(installation.authorizedAppId);
    expect(html).not.toContain(installation.merchantId);
    expect(mocks.readMonitoringSettings).toHaveBeenCalledWith(installation);
  });
});
