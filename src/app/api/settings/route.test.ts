import { beforeEach, describe, expect, it, vi } from "vitest";
import { MonitoringSettingsStoreError } from "@/lib/settings/settings-store";
import {
  SettingsAccessError,
  SettingsValidationError,
} from "@/lib/settings/settings-service";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  readMonitoringSettings: vi.fn(),
  updateMonitoringSettings: vi.fn(),
  getCanonicalAppOrigin: vi.fn(),
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
  updateMonitoringSettings: mocks.updateMonitoringSettings,
}));

vi.mock("@/helpers/api-helpers", () => ({
  getCanonicalAppOrigin: mocks.getCanonicalAppOrigin,
}));

vi.mock("@/lib/monitoring/verified-recipient", () => ({
  resolveVerifiedRecipient: mocks.resolveVerifiedRecipient,
}));

vi.mock("@/lib/monitoring/email-summary", () => ({
  isDailySummaryEmailConfigured: mocks.isDailySummaryEmailConfigured,
}));

import { GET, POST } from "./route";

const installation = {
  authorizedAppId: "session-app",
  merchantId: "session-merchant",
  storeName: "session-store",
};

function settingsPostRequest(
  body: Record<string, string> = { lowStockThreshold: "25", dailyEmailEnabled: "on" },
  {
    origin = "https://health.example.com",
    url = "https://health.example.com/api/settings",
    accept = "text/html",
  } = {},
) {
  const form = new URLSearchParams(body);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept,
  };
  if (origin) headers.origin = origin;
  return new Request(url, { method: "POST", headers, body: form.toString() });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("IKAS_MONITORING_SCHEDULER_ENABLED", "true");
  mocks.getSession.mockResolvedValue({ ...installation });
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.getCanonicalAppOrigin.mockReturnValue("https://health.example.com");
  mocks.readMonitoringSettings.mockResolvedValue({
    tier: "pro",
    settings: { lowStockThreshold: 10, dailyEmailEnabled: false },
  });
  mocks.updateMonitoringSettings.mockResolvedValue({
    tier: "pro",
    settings: { lowStockThreshold: 25, dailyEmailEnabled: true },
  });
  mocks.resolveVerifiedRecipient.mockReturnValue({ email: "owner@example.com" });
  mocks.isDailySummaryEmailConfigured.mockReturnValue(true);
});

describe("GET /api/settings", () => {
  it("returns the active-Pro settings for the session tenant", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      tier: "pro",
      settings: { lowStockThreshold: 10, dailyEmailEnabled: false },
    });
    expect(mocks.readMonitoringSettings).toHaveBeenCalledWith(installation);
  });

  it("returns 401 when there is no installation session", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.readMonitoringSettings).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-Pro merchant without leaking data", async () => {
    mocks.readMonitoringSettings.mockRejectedValue(new SettingsAccessError());
    const response = await GET();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "IKAS_PRO_FEATURE_REQUIRED" });
  });

  it("returns 503 when the settings backend is unavailable", async () => {
    mocks.readMonitoringSettings.mockRejectedValue(new MonitoringSettingsStoreError("backend", "get"));
    const response = await GET();
    expect(response.status).toBe(503);
  });
});

describe("POST /api/settings", () => {
  it("persists the submitted settings and redirects to a safe status", async () => {
    const response = await POST(settingsPostRequest());

    expect(mocks.updateMonitoringSettings).toHaveBeenCalledWith(installation, {
      lowStockThreshold: 25,
      dailyEmailEnabled: true,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://health.example.com/settings?status=saved");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("treats an unchecked email box as disabled", async () => {
    await POST(settingsPostRequest({ lowStockThreshold: "0" }));
    expect(mocks.updateMonitoringSettings).toHaveBeenCalledWith(installation, {
      lowStockThreshold: 0,
      dailyEmailEnabled: false,
    });
  });

  it("does not enable email when the verified recipient is unavailable", async () => {
    mocks.resolveVerifiedRecipient.mockReturnValue(undefined);

    const response = await POST(settingsPostRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://health.example.com/settings?status=unavailable",
    );
    expect(mocks.updateMonitoringSettings).not.toHaveBeenCalled();
  });

  it("does not enable email while the scheduler is disabled", async () => {
    vi.stubEnv("IKAS_MONITORING_SCHEDULER_ENABLED", "false");

    const response = await POST(settingsPostRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://health.example.com/settings?status=unavailable",
    );
    expect(mocks.updateMonitoringSettings).not.toHaveBeenCalled();
  });

  it("does not enable email while provider delivery configuration is invalid", async () => {
    mocks.isDailySummaryEmailConfigured.mockReturnValue(false);

    const response = await POST(settingsPostRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://health.example.com/settings?status=unavailable",
    );
    expect(mocks.updateMonitoringSettings).not.toHaveBeenCalled();
  });

  it("preserves an already-enabled email setting while delivery is temporarily unready", async () => {
    mocks.readMonitoringSettings.mockResolvedValue({
      tier: "pro",
      settings: { lowStockThreshold: 10, dailyEmailEnabled: true },
    });
    mocks.isDailySummaryEmailConfigured.mockReturnValue(false);

    const response = await POST(settingsPostRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://health.example.com/settings?status=saved");
    expect(mocks.updateMonitoringSettings).toHaveBeenCalledWith(installation, {
      lowStockThreshold: 25,
      dailyEmailEnabled: true,
    });
  });

  it("ignores any client-supplied tenant selector in the body or query", async () => {
    await POST(
      settingsPostRequest(
        { lowStockThreshold: "5", dailyEmailEnabled: "on", authorizedAppId: "attacker", merchantId: "evil" },
        { url: "https://health.example.com/api/settings?authorizedAppId=attacker" },
      ),
    );

    expect(mocks.updateMonitoringSettings).toHaveBeenCalledWith(installation, {
      lowStockThreshold: 5,
      dailyEmailEnabled: true,
    });
  });

  it("rejects a cross-origin submission before writing", async () => {
    const response = await POST(settingsPostRequest(undefined, { origin: "https://attacker.example" }));
    expect(response.status).toBe(403);
    expect(mocks.updateMonitoringSettings).not.toHaveBeenCalled();
  });

  it("rejects a submission without an Origin header before writing", async () => {
    const response = await POST(settingsPostRequest(undefined, { origin: "" }));
    expect(response.status).toBe(403);
    expect(mocks.updateMonitoringSettings).not.toHaveBeenCalled();
  });

  it("returns an expired browser session to the recoverable settings UI", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);
    const response = await POST(settingsPostRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://health.example.com/settings?status=error");
    expect(mocks.updateMonitoringSettings).not.toHaveBeenCalled();
  });

  it("keeps a JSON 401 for non-browser clients without a session", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);
    const response = await POST(settingsPostRequest(undefined, { accept: "application/json" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(mocks.updateMonitoringSettings).not.toHaveBeenCalled();
  });

  it("redirects to an invalid status for a rejected value in a browser submit", async () => {
    mocks.updateMonitoringSettings.mockRejectedValue(new SettingsValidationError());
    const response = await POST(settingsPostRequest({ lowStockThreshold: "9999" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://health.example.com/settings?status=invalid");
  });

  it("returns browser submissions to the settings page when Pro access is unavailable", async () => {
    mocks.updateMonitoringSettings.mockRejectedValue(new SettingsAccessError());
    const response = await POST(settingsPostRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://health.example.com/settings?status=error");
  });

  it("returns browser submissions to the settings page when the backend is unavailable", async () => {
    mocks.updateMonitoringSettings.mockRejectedValue(new MonitoringSettingsStoreError("backend", "put"));
    const response = await POST(settingsPostRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://health.example.com/settings?status=error");
  });
});
