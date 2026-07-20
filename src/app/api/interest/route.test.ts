import { beforeEach, describe, expect, it, vi } from "vitest";
import { InterestStoreError } from "@/lib/interest/interest-store";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  recordInterest: vi.fn(),
  getCanonicalAppOrigin: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/interest/interest-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/interest/interest-store")>()),
  recordInterest: mocks.recordInterest,
}));

vi.mock("@/helpers/api-helpers", () => ({
  getCanonicalAppOrigin: mocks.getCanonicalAppOrigin,
}));

import { POST } from "./route";

const installation = {
  authorizedAppId: "session-app",
  merchantId: "session-merchant",
  storeName: "session-store",
};

function interestRequest(body: Record<string, string> = {}, url = "https://health.example.com/api/interest") {
  const form = new URLSearchParams({ intent: "low_stock_threshold_monitoring", ...body });
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://health.example.com",
    },
    body: form.toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ ...installation });
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.recordInterest.mockResolvedValue("recorded");
  mocks.getCanonicalAppOrigin.mockReturnValue("https://health.example.com");
});

describe("POST /api/interest", () => {
  it("records the session tenant and redirects to a safe thank-you status", async () => {
    const response = await POST(interestRequest());

    expect(mocks.recordInterest).toHaveBeenCalledOnce();
    expect(mocks.recordInterest.mock.calls[0]?.[0]).toEqual({
      authorizedAppId: "session-app",
      merchantId: "session-merchant",
      intent: "low_stock_threshold_monitoring",
      createdAt: expect.any(Number),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://health.example.com/?interest=recorded");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("ignores client-supplied tenant identity and uses only the installation session", async () => {
    const response = await POST(
      interestRequest(
        { authorizedAppId: "attacker-app", merchantId: "attacker-merchant" },
        "https://health.example.com/api/interest?authorizedAppId=attacker-app",
      ),
    );

    expect(response.status).toBe(303);
    expect(mocks.recordInterest.mock.calls[0]?.[0]).toMatchObject({
      authorizedAppId: "session-app",
      merchantId: "session-merchant",
    });
  });

  it("treats a repeated signal as success without reporting a second record", async () => {
    mocks.recordInterest.mockResolvedValue("already_recorded");

    const response = await POST(interestRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://health.example.com/?interest=recorded");
  });

  it("returns 401 without recording anything when the installation session is missing", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await POST(interestRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(mocks.recordInterest).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent without touching the store", async () => {
    const response = await POST(interestRequest({ intent: "spoofed_intent" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "IKAS_INTEREST_INTENT_INVALID" });
    expect(mocks.recordInterest).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before recording anything", async () => {
    const request = interestRequest();
    request.headers.set("origin", "https://attacker.example");

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "IKAS_INTEREST_ORIGIN_INVALID" });
    expect(mocks.recordInterest).not.toHaveBeenCalled();
  });

  it("rejects a request without an Origin header before recording anything", async () => {
    const request = interestRequest();
    request.headers.delete("origin");

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "IKAS_INTEREST_ORIGIN_INVALID" });
    expect(mocks.recordInterest).not.toHaveBeenCalled();
  });

  it("returns a private 503 when the durable backend is unavailable", async () => {
    mocks.recordInterest.mockRejectedValue(new InterestStoreError("backend", "record"));

    const response = await POST(interestRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "IKAS_INTEREST_BACKEND_UNAVAILABLE" });
  });

  it("returns a private 503 rather than a fake success when no backend is configured", async () => {
    mocks.recordInterest.mockRejectedValue(new InterestStoreError("configuration", "configure"));

    const response = await POST(interestRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "IKAS_INTEREST_BACKEND_UNAVAILABLE" });
  });
});
