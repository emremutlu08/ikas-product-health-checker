import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runDailyMonitoring: vi.fn(),
}));

vi.mock("@/lib/monitoring/daily-monitoring", () => ({
  runDailyMonitoring: mocks.runDailyMonitoring,
}));

import { GET } from "./route";

function request(authorization?: string) {
  return new Request("https://health.example.com/api/internal/monitoring/daily", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("daily monitoring cron route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "cron_secret_value_that_is_long_enough");
    vi.stubEnv("IKAS_MONITORING_SCHEDULER_ENABLED", "true");
    mocks.runDailyMonitoring.mockResolvedValue({
      inspected: 8,
      claimed: 6,
      scheduled: 4,
      sent: 3,
      busy: 1,
      failed: 0,
    });
  });

  it("rejects missing or incorrect bearer credentials before scheduler IO", async () => {
    const missing = await GET(request());
    const incorrect = await GET(request("Bearer wrong_secret_value_that_is_long_enough"));

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.runDailyMonitoring).not.toHaveBeenCalled();
  });

  it("runs the scheduler once and returns aggregate-only results", async () => {
    const response = await GET(request("Bearer cron_secret_value_that_is_long_enough"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.runDailyMonitoring).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ inspected: 8, claimed: 6, scheduled: 4, sent: 3, busy: 1, failed: 0 });
    expect(JSON.stringify(body)).not.toContain("merchant");
    expect(JSON.stringify(body)).not.toContain("@");
  });

  it("stays fail-closed until the scheduler is explicitly enabled", async () => {
    vi.stubEnv("IKAS_MONITORING_SCHEDULER_ENABLED", "false");

    const response = await GET(request("Bearer cron_secret_value_that_is_long_enough"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "IKAS_MONITORING_UNAVAILABLE" });
    expect(mocks.runDailyMonitoring).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is missing or too short", async () => {
    vi.stubEnv("CRON_SECRET", "short");

    const response = await GET(request("Bearer short"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "IKAS_MONITORING_UNAVAILABLE" });
    expect(mocks.runDailyMonitoring).not.toHaveBeenCalled();
  });

  it("returns a generic failure without exposing backend details", async () => {
    mocks.runDailyMonitoring.mockRejectedValueOnce(new Error("merchant-1 owner@example.com redis-token"));

    const response = await GET(request("Bearer cron_secret_value_that_is_long_enough"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "IKAS_MONITORING_FAILED" });
    expect(JSON.stringify(body)).not.toContain("merchant-1");
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
  });
});
