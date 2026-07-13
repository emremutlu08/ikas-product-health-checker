import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getOAuthUrl: vi.fn(),
  getSession: vi.fn(),
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

import { GET } from "./route";

describe("GET /api/oauth/authorize/ikas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOAuthUrl.mockReturnValue("https://dev-emre2.myikas.com/api/admin/oauth");
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
