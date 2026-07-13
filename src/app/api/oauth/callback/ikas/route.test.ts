import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getTokenWithAuthorizationCode: vi.fn(),
  saveIkasToken: vi.fn(),
}));

vi.mock("@/globals/config", () => ({
  config: {
    deployUrl: "https://app.example.com",
    graphApiUrl: "https://api.myikas.com/api/v2/admin/graphql",
    oauth: {
      clientId: "client-id",
      clientSecret: "client-secret",
      scope: "read_products,read_inventories",
    },
  },
}));

vi.mock("@ikas/admin-api-client", () => ({
  OAuthAPI: {
    getTokenWithAuthorizationCode: mocks.getTokenWithAuthorizationCode,
  },
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, getSession: mocks.getSession };
});

vi.mock("@/lib/ikas/token-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ikas/token-store")>();
  return { ...actual, saveIkasToken: mocks.saveIkasToken };
});

import { GET } from "./route";

function createSession(storeName = "dev-emre2") {
  return {
    state: "oauth-state",
    stateIssuedAt: Date.now() - 1_000,
    storeName,
    accessToken: "legacy-access-token",
    refreshToken: "legacy-refresh-token",
    save: vi.fn(async () => undefined),
  };
}

describe("GET /api/oauth/callback/ikas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTokenWithAuthorizationCode.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });
    mocks.saveIkasToken.mockImplementation(async (token) => ({ ...token }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              getMerchant: { id: "merchant-1", storeName: "dev-emre2" },
              getAuthorizedApp: { id: "authorized-app-1" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  });

  it("exchanges only against the exact session store and returns a bare canonical redirect", async () => {
    const session = createSession();
    mocks.getSession.mockResolvedValue(session);

    const response = await GET(
      new NextRequest(
        "https://attacker.invalid/api/oauth/callback/ikas?code=authorization-code&state=oauth-state&storeName=dev-emre2",
        {
          headers: {
            host: "attacker.invalid",
            "x-forwarded-host": "attacker.invalid",
            "x-forwarded-proto": "http",
          },
        },
      ),
    );

    expect(mocks.getTokenWithAuthorizationCode).toHaveBeenCalledWith(
      {
        code: "authorization-code",
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uri: "https://app.example.com/api/oauth/callback/ikas",
      },
      { storeName: "dev-emre2" },
    );
    expect(response.headers.get("location")).toBe("https://app.example.com/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect({ ...session }).toEqual({
      authorizedAppId: "authorized-app-1",
      merchantId: "merchant-1",
      storeName: "dev-emre2",
      save: expect.any(Function),
    });
    expect(session.save).toHaveBeenCalledTimes(2);
  });

  it.each([
    "other-store",
    "attacker.example%5Ctoken",
    "user%40attacker",
    "foo%00bar",
    "foo%0Dbar",
    "foo%0Abar",
    "foo%09bar",
  ])("rejects callback store selector %s before the secret-bearing token request", async (encodedStoreName) => {
    const session = createSession();
    mocks.getSession.mockResolvedValue(session);

    const response = await GET(
      new NextRequest(
        `https://app.example.com/api/oauth/callback/ikas?code=authorization-code&state=oauth-state&storeName=${encodedStoreName}`,
      ),
    );

    expect(mocks.getTokenWithAuthorizationCode).not.toHaveBeenCalled();
    expect(mocks.saveIkasToken).not.toHaveBeenCalled();
    expect(session.save).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toMatch(
      /^https:\/\/app\.example\.com\/authorize-store\?status=fail&reason=invalid_store_name&/,
    );
    expect(response.headers.get("location")).not.toContain("attacker.example");
  });

  it("rejects a hostile session store even when callback storeName is absent", async () => {
    const session = createSession("attacker.example\\token");
    mocks.getSession.mockResolvedValue(session);

    const response = await GET(
      new NextRequest(
        "https://app.example.com/api/oauth/callback/ikas?code=authorization-code&state=oauth-state",
      ),
    );

    expect(mocks.getTokenWithAuthorizationCode).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain("reason=invalid_store_name");
    expect(response.headers.get("location")).not.toContain("attacker.example");
  });
});
