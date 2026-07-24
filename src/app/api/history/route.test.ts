import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryAccessError } from "@/lib/billing/history-service";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import { SnapshotStoreError } from "@/lib/scans/snapshot-store";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  getProductHealthHistory: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/billing/history-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/history-service")>()),
  getProductHealthHistory: mocks.getProductHealthHistory,
}));

import { GET as getHistory } from "./route";

const installation = {
  authorizedAppId: "session-app",
  merchantId: "session-merchant",
  storeName: "session-store",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ ...installation });
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.getProductHealthHistory.mockResolvedValue({
    tier: "pro",
    entries: [
      {
        scanId: "scan-1",
        generatedAt: "2026-07-22T08:00:00.000Z",
        health: { state: "healthy", score: 95, label: "Sağlıklı", weightedIssuePoints: 1 },
        productCount: 10,
        affectedProductCount: 1,
        issueCount: 1,
        changes: { baseline: "missing", added: 0, ongoing: 0, resolved: 0 },
      },
    ],
  });
});

describe("GET /api/history", () => {
  it("requires a sealed installation session", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await getHistory();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(mocks.getProductHealthHistory).not.toHaveBeenCalled();
  });

  it("returns the safe Pro history projection with private no-store caching", async () => {
    const response = await getHistory();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      tier: "pro",
      entries: [{ scanId: "scan-1", changes: { baseline: "missing" } }],
    });
    expect(mocks.getProductHealthHistory).toHaveBeenCalledWith(installation);
  });

  it("returns a generic Pro-required response without entitlement internals", async () => {
    mocks.getProductHealthHistory.mockRejectedValue(new HistoryAccessError());

    const response = await getHistory();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "IKAS_PRO_FEATURE_REQUIRED" });
  });

  it("maps authentication and snapshot backend failures without leaking raw messages", async () => {
    mocks.getProductHealthHistory.mockRejectedValueOnce(
      new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED"),
    );
    const authResponse = await getHistory();
    expect(authResponse.status).toBe(401);

    mocks.getProductHealthHistory.mockRejectedValueOnce(
      new SnapshotStoreError("backend", "history"),
    );
    const backendResponse = await getHistory();
    expect(backendResponse.status).toBe(503);
    await expect(backendResponse.json()).resolves.toEqual({
      error: "IKAS_SNAPSHOT_BACKEND_UNAVAILABLE",
    });
  });

  it("maps unknown failures to a fixed response", async () => {
    mocks.getProductHealthHistory.mockRejectedValue(new Error("secret upstream text"));

    const response = await getHistory();
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(body).toBe('{"error":"IKAS_HISTORY_FAILED"}');
    expect(body).not.toContain("secret upstream text");
  });
});
