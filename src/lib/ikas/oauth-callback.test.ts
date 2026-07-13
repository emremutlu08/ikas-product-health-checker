import { describe, expect, it, vi } from "vitest";
import {
  OAUTH_CALLBACK_STAGES,
  OAUTH_STATE_FUTURE_SKEW_MS,
  OAUTH_STATE_TTL_MS,
  processIkasOAuthCallback,
  type OAuthCallbackDependencies,
  type OAuthCallbackInput,
  type OAuthCallbackLogEvent,
  type OAuthCallbackSession,
} from "./oauth-callback";
import { TokenStoreError, type StoredIkasToken } from "./token-store";

const ERROR_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-07-13T10:00:00.000Z");

function responseJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFixture(
  dependencyOverrides: Partial<OAuthCallbackDependencies> = {},
  inputOverrides: Partial<OAuthCallbackInput> = {},
) {
  const events: OAuthCallbackLogEvent[] = [];
  const session: OAuthCallbackSession = {
    state: "oauth-state",
    stateIssuedAt: NOW - 60_000,
    storeName: "dev-emre2",
    accessToken: "legacy-access-token",
    refreshToken: "legacy-refresh-token",
    tokenType: "Bearer",
    expiresAt: NOW,
    save: vi.fn(async () => undefined),
  };
  const exchangeToken = vi.fn(async () => ({
    ok: true,
    status: 200,
    data: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    },
  }));
  const persistToken = vi.fn(async (token: StoredIkasToken) => ({ ...token }));
  const dependencies: OAuthCallbackDependencies = {
    getOAuthConfig: () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    getSession: async () => session,
    exchangeToken,
    queryAppContext: async () =>
      responseJson({
        data: {
          getMerchant: { id: "merchant-1", storeName: "dev-emre2" },
          getAuthorizedApp: { id: "authorized-app-1" },
        },
      }),
    persistToken,
    createCorrelationId: () => ERROR_ID,
    now: () => NOW,
    logger: {
      info: (event) => events.push(event),
      error: (event) => events.push(event),
    },
    ...dependencyOverrides,
  };
  const input: OAuthCallbackInput = {
    code: "authorization-code",
    state: "oauth-state",
    storeName: "dev-emre2",
    redirectUri: "https://app.example.com/api/oauth/callback/ikas",
    successBaseUrl: "https://app.example.com",
    ...inputOverrides,
  };

  return { dependencies, events, exchangeToken, input, persistToken, session };
}

describe("processIkasOAuthCallback", () => {
  it("persists a verified installation, establishes a tenant-only session, and returns a clean redirect", async () => {
    const fixture = createFixture();

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({
      ok: true,
      correlationId: ERROR_ID,
      authorizedAppId: "authorized-app-1",
      storeName: "dev-emre2",
    });
    if (!result.ok) throw new Error("expected successful callback");
    expect(result.redirectUrl.toString()).toBe("https://app.example.com/");
    expect(result.redirectUrl.searchParams.has("authorizedAppId")).toBe(false);
    expect(fixture.persistToken).toHaveBeenCalledWith({
      authorizedAppId: "authorized-app-1",
      merchantId: "merchant-1",
      storeName: "dev-emre2",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: NOW + 3600 * 1000,
    });
    expect({ ...fixture.session }).toEqual({
      authorizedAppId: "authorized-app-1",
      merchantId: "merchant-1",
      storeName: "dev-emre2",
      save: expect.any(Function),
    });
    expect(fixture.session.save).toHaveBeenCalledTimes(2);
    expect(
      fixture.events.filter((event) => event.outcome === "success").map((event) => event.stage),
    ).toEqual(OAUTH_CALLBACK_STAGES);
  });

  it("uses the exact validated session store when the callback omits storeName", async () => {
    const fixture = createFixture({}, { storeName: undefined });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result.ok).toBe(true);
    expect(fixture.exchangeToken).toHaveBeenCalledWith(
      expect.objectContaining({ storeName: "dev-emre2" }),
    );
  });

  it.each([
    "other-store",
    "attacker.example\\token",
    "user@attacker",
    "attacker%5ctoken",
    "foo\u0000bar",
    "foo\rbar",
    "foo\nbar",
    "foo\tbar",
    "",
  ])("rejects a callback store override %j before token exchange", async (storeName) => {
    const fixture = createFixture({}, { storeName });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "invalid_store_name", storeName: "dev-emre2" });
    expect(fixture.exchangeToken).not.toHaveBeenCalled();
    expect(fixture.session.save).not.toHaveBeenCalled();
  });

  it.each(["attacker.example\\token", "user@attacker", "foo\u0000bar", "foo.myikas.com", ""])(
    "rejects an invalid session-bound store %j before token exchange",
    async (storeName) => {
      const fixture = createFixture({}, { storeName: undefined });
      fixture.session.storeName = storeName;

      const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

      expect(result).toMatchObject({ ok: false, reason: "invalid_store_name" });
      expect(fixture.exchangeToken).not.toHaveBeenCalled();
    },
  );

  it("requires callback state to be present", async () => {
    const fixture = createFixture({}, { state: undefined });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "state_missing", errorId: ERROR_ID });
    expect(fixture.persistToken).not.toHaveBeenCalled();
  });

  it("requires callback state to exactly match the session state", async () => {
    const fixture = createFixture({}, { state: " oauth-state " });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "state_mismatch", errorId: ERROR_ID });
    expect(fixture.persistToken).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", issuedAt: undefined },
    { label: "expired", issuedAt: NOW - OAUTH_STATE_TTL_MS - 1 },
    { label: "too far in the future", issuedAt: NOW + OAUTH_STATE_FUTURE_SKEW_MS + 1 },
  ])("rejects $label OAuth state timestamps", async ({ issuedAt }) => {
    const fixture = createFixture();
    fixture.session.stateIssuedAt = issuedAt;

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "state_mismatch" });
    expect(fixture.exchangeToken).not.toHaveBeenCalled();
    expect(fixture.session.save).not.toHaveBeenCalled();
  });

  it("consumes state before a token exchange failure", async () => {
    const fixture = createFixture({
      exchangeToken: async () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }),
    });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "token_exchange_failed", errorId: ERROR_ID });
    expect(fixture.persistToken).not.toHaveBeenCalled();
    expect(fixture.session.state).toBeUndefined();
    expect(fixture.session.stateIssuedAt).toBeUndefined();
    expect(fixture.session.save).toHaveBeenCalledOnce();
  });

  it("requires an initial refresh token before persisting an installation", async () => {
    const fixture = createFixture({
      exchangeToken: async () => ({
        ok: true,
        status: 200,
        data: { access_token: "access-token", expires_in: 3600 },
      }),
    });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "token_exchange_failed" });
    expect(fixture.persistToken).not.toHaveBeenCalled();
    expect(fixture.session.save).toHaveBeenCalledOnce();
  });

  it("rejects context GraphQL errors even when the HTTP response is 200", async () => {
    const fixture = createFixture({
      queryAppContext: async () => responseJson({ errors: [{ message: "provider detail" }] }),
    });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "app_context_graphql_error", errorId: ERROR_ID });
    expect(fixture.persistToken).not.toHaveBeenCalled();
  });

  it("rejects context responses without an authorizedAppId", async () => {
    const fixture = createFixture({
      queryAppContext: async () =>
        responseJson({
          data: {
            getMerchant: { id: "merchant-1", storeName: "dev-emre2" },
            getAuthorizedApp: null,
          },
        }),
    });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "authorized_app_missing", errorId: ERROR_ID });
    expect(fixture.persistToken).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "other-store", "Dev-Emre2", "attacker.example\\token", "user@attacker"])(
    "rejects missing, invalid, or cross-tenant merchant store context %j",
    async (merchantStoreName) => {
      const fixture = createFixture({
        queryAppContext: async () =>
          responseJson({
            data: {
              getMerchant: { id: "merchant-1", storeName: merchantStoreName },
              getAuthorizedApp: { id: "authorized-app-1" },
            },
          }),
      });

      const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

      expect(result).toMatchObject({ ok: false, reason: "merchant_context_missing" });
      expect(fixture.persistToken).not.toHaveBeenCalled();
      expect(fixture.session.save).toHaveBeenCalledOnce();
    },
  );

  it("requires persistence to return the exact durable token readback", async () => {
    const fixture = createFixture({
      persistToken: async (token) => ({ ...token, merchantId: "other-merchant" }),
    });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "token_persist_failed", storeName: "dev-emre2" });
    expect(fixture.session.save).toHaveBeenCalledOnce();
    expect(fixture.session.authorizedAppId).toBeUndefined();
  });

  it("returns an allowlisted persistence reason without establishing an installation session", async () => {
    const fixture = createFixture({
      persistToken: vi.fn().mockRejectedValue(new TokenStoreError("backend", "set")),
    });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toEqual({
      ok: false,
      correlationId: ERROR_ID,
      errorId: ERROR_ID,
      reason: "token_persist_failed",
      storeName: "dev-emre2",
    });
    expect(fixture.session.save).toHaveBeenCalledOnce();
    expect(fixture.session.authorizedAppId).toBeUndefined();
  });

  it("reports missing persistent-store configuration separately", async () => {
    const fixture = createFixture({
      persistToken: vi.fn().mockRejectedValue(new TokenStoreError("configuration", "configure")),
    });

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);

    expect(result).toMatchObject({ ok: false, reason: "token_store_unavailable", errorId: ERROR_ID });
  });

  it("keeps authorization codes, cookies, tokens, client secrets, and auth headers out of diagnostics", async () => {
    const secrets = {
      code: "AUTHORIZATION_CODE_SENTINEL",
      accessToken: "ACCESS_TOKEN_SENTINEL",
      refreshToken: "REFRESH_TOKEN_SENTINEL",
      clientSecret: "CLIENT_SECRET_SENTINEL",
      redisToken: "REDIS_TOKEN_SENTINEL",
      cookie: "COOKIE_SENTINEL",
      authHeader: "AUTH_HEADER_SENTINEL",
    };
    const fixture = createFixture(
      {
        getOAuthConfig: () => ({ clientId: "client-id", clientSecret: secrets.clientSecret }),
        exchangeToken: async () => ({
          ok: true,
          status: 200,
          data: {
            access_token: secrets.accessToken,
            refresh_token: secrets.refreshToken,
            expires_in: 3600,
          },
        }),
        persistToken: vi.fn().mockRejectedValue(
          new Error(
            `${secrets.redisToken} Cookie=${secrets.cookie} Authorization=Bearer ${secrets.authHeader}`,
          ),
        ),
      },
      { code: secrets.code },
    );

    const result = await processIkasOAuthCallback(fixture.input, fixture.dependencies);
    const diagnostics = JSON.stringify({ events: fixture.events, result });

    for (const secret of Object.values(secrets)) {
      expect(diagnostics).not.toContain(secret);
    }
    expect(diagnostics).toContain(ERROR_ID);
    expect(diagnostics).toContain("token_persist_failed");
  });
});
