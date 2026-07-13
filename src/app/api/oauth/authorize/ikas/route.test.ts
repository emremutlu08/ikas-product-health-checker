import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getOAuthUrl: vi.fn(),
  getSession: vi.fn(),
  persistOAuthState: vi.fn(),
}));

vi.mock("@/globals/config", () => ({
  config: {
    deployUrl: "https://app.example.com",
    oauth: {
      clientId: "client-id",
      clientSecret: "client-secret",
      scope: "read_products,read_inventories",
    },
  },
}));

vi.mock("@ikas/admin-api-client", () => ({
  OAuthAPI: {
    getOAuthUrl: mocks.getOAuthUrl,
  },
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, getSession: mocks.getSession };
});

vi.mock("@/lib/ikas/oauth-state-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ikas/oauth-state-store")>();
  return { ...actual, persistOAuthState: mocks.persistOAuthState };
});

import { GET } from "./route";

describe("GET /api/oauth/authorize/ikas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOAuthUrl.mockReturnValue("https://dev-emre2.myikas.com/api/admin/oauth");
    mocks.persistOAuthState.mockResolvedValue(undefined);
  });

  it("stores bounded state context and redirects using only the validated store and canonical callback", async () => {
    const session = {
      authorizedAppId: "old-app",
      merchantId: "old-merchant",
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      save: vi.fn(async () => undefined),
    };
    mocks.getSession.mockResolvedValue(session);

    const response = await GET(
      new NextRequest("https://attacker.invalid/api/oauth/authorize/ikas?storeName=dev-emre2", {
        headers: {
          host: "attacker.invalid",
          "x-forwarded-host": "attacker.invalid",
          "x-forwarded-proto": "http",
        },
      }),
    );

    expect(mocks.getOAuthUrl).toHaveBeenCalledWith({ storeName: "dev-emre2" });
    expect(response.headers.get("location")).toContain(
      `redirect_uri=${encodeURIComponent("https://app.example.com/api/oauth/callback/ikas")}`,
    );
    expect(response.headers.get("location")).toMatch(
      /^https:\/\/dev-emre2\.myikas\.com\/api\/admin\/oauth\/authorize\?/,
    );
    const [state, record, ttlMs] = mocks.persistOAuthState.mock.calls[0];
    expect(state).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.[0-9a-z]{1,11}$/);
    expect(record).toEqual({ storeName: "dev-emre2", createdAt: expect.any(Number) });
    expect(Object.keys(record).sort()).toEqual(["createdAt", "storeName"]);
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(5 * 60_000);
    expect(new URL(response.headers.get("location")!).searchParams.get("state")).toBe(state);
    expect(mocks.persistOAuthState.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getOAuthUrl.mock.invocationCallOrder[0],
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(session).toMatchObject({
      state: expect.any(String),
      stateIssuedAt: expect.any(Number),
      storeName: "dev-emre2",
    });
    expect(session).not.toHaveProperty("authorizedAppId");
    expect(session).not.toHaveProperty("merchantId");
    expect(session).not.toHaveProperty("accessToken");
    expect(session).not.toHaveProperty("refreshToken");
    expect(session.save).toHaveBeenCalledOnce();
  });

  it("blocks the provider redirect when server-side state persistence fails", async () => {
    const diagnosticSentinels = ["STATE_VALUE_SENTINEL", "REDIS_TOKEN_SENTINEL", "CLIENT_SECRET_SENTINEL"];
    mocks.persistOAuthState.mockRejectedValue(new Error(diagnosticSentinels.join(":")));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(
      new NextRequest("https://app.example.com/api/oauth/authorize/ikas?storeName=dev-emre2"),
    );

    expect(response.headers.get("location")).toMatch(
      /^https:\/\/app\.example\.com\/authorize-store\?status=fail&reason=state_store_unavailable&/,
    );
    expect(mocks.getOAuthUrl).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    const diagnostics = consoleError.mock.calls.flat().join(" ");
    for (const sentinel of diagnosticSentinels) expect(diagnostics).not.toContain(sentinel);
    expect(diagnostics).toContain("state_store_unavailable");
    expect(diagnostics).toContain("state_persist");
    consoleError.mockRestore();
  });

  it.each([
    "attacker.example%5Ctoken",
    "user%40attacker",
    "foo%00bar",
    "foo%0Dbar",
    "foo%0Abar",
    "foo%09bar",
    "attacker%252eexample",
    "https%3A%2F%2Fattacker.example%2Fadmin",
  ])("rejects hostile encoded store input %s before OAuth URL construction", async (encodedStoreName) => {
    const session = { save: vi.fn(async () => undefined) };
    mocks.getSession.mockResolvedValue(session);

    const response = await GET(
      new NextRequest(
        `https://app.example.com/api/oauth/authorize/ikas?storeName=${encodedStoreName}`,
      ),
    );

    expect(response.headers.get("location")).toMatch(
      /^https:\/\/app\.example\.com\/authorize-store\?status=fail&reason=invalid_store_name&/,
    );
    expect(mocks.getOAuthUrl).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(session.save).not.toHaveBeenCalled();
  });
});
