import { describe, expect, it, vi } from "vitest";
import {
  clearSessionData,
  consumeOAuthStateSession,
  getSessionCookieConfig,
  readInstallationSession,
  saveInstallationSession,
  saveOAuthStateSession,
  saveSanitizedSession,
  type SessionHandle,
} from "./session";

describe("session cookie configuration", () => {
  it("uses embedded production attributes and keeps the existing TTL", () => {
    expect(getSessionCookieConfig("production")).toEqual({
      ttl: 8 * 60 * 60,
      cookieOptions: {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        partitioned: true,
      },
    });
  });

  it("keeps development cookies compatible without partitioning", () => {
    const config = getSessionCookieConfig("development");

    expect(config).toEqual({
      ttl: 8 * 60 * 60,
      cookieOptions: {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
      },
    });
    expect(config.cookieOptions).not.toHaveProperty("partitioned");
  });
});

function createSession(values: Record<string, unknown> = {}) {
  return {
    ...values,
    save: vi.fn(async () => undefined),
  } as SessionHandle & Record<string, unknown>;
}

describe("installation sessions", () => {
  it("reads only a complete validated tenant identity", () => {
    expect(
      readInstallationSession({
        authorizedAppId: "authorized-app-1",
        merchantId: "merchant-1",
        storeName: "tenant-store",
      }),
    ).toEqual({
      authorizedAppId: "authorized-app-1",
      merchantId: "merchant-1",
      storeName: "tenant-store",
    });

    expect(readInstallationSession({ authorizedAppId: "authorized-app-1", storeName: "tenant-store" })).toBeUndefined();
    expect(
      readInstallationSession({
        authorizedAppId: "authorized-app-1",
        merchantId: "merchant-1",
        storeName: "attacker.example\\path",
      }),
    ).toBeUndefined();
  });

  it("saves an installation session containing only tenant identifiers", async () => {
    const session = createSession({
      state: "old-state",
      stateIssuedAt: 1,
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      tokenType: "Bearer",
      expiresAt: 123,
      unexpected: "remove-me",
    });

    await saveInstallationSession(session, {
      authorizedAppId: "authorized-app-1",
      merchantId: "merchant-1",
      storeName: "tenant-store",
    });

    expect({ ...session }).toEqual({
      authorizedAppId: "authorized-app-1",
      merchantId: "merchant-1",
      storeName: "tenant-store",
      save: expect.any(Function),
    });
    expect(session.save).toHaveBeenCalledOnce();
  });
});

describe("OAuth state sessions", () => {
  it("replaces prior installation and legacy token data with short-lived state context", async () => {
    const session = createSession({
      authorizedAppId: "old-app",
      merchantId: "old-merchant",
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      unexpected: "remove-me",
    });

    await saveOAuthStateSession(session, {
      state: "11111111-1111-4111-8111-111111111111",
      stateIssuedAt: 1_700_000_000_000,
      storeName: "tenant-store",
    });

    expect({ ...session }).toEqual({
      state: "11111111-1111-4111-8111-111111111111",
      stateIssuedAt: 1_700_000_000_000,
      storeName: "tenant-store",
      save: expect.any(Function),
    });
  });

  it("consumes all state before token exchange", async () => {
    const session = createSession({
      state: "oauth-state",
      stateIssuedAt: 1_700_000_000_000,
      storeName: "tenant-store",
      accessToken: "legacy-access-token",
    });

    await consumeOAuthStateSession(session);

    expect({ ...session }).toEqual({ save: expect.any(Function) });
    expect(session.save).toHaveBeenCalledOnce();
  });

  it("strips every legacy token key whenever using the sanitized save", async () => {
    const session = createSession({
      storeName: "tenant-store",
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      tokenType: "Bearer",
      expiresAt: 123,
    });

    await saveSanitizedSession(session);

    expect({ ...session }).toEqual({ storeName: "tenant-store", save: expect.any(Function) });
  });

  it("can clear a rejected session without retaining unknown data", async () => {
    const session = createSession({ authorizedAppId: "bad-app", unexpected: "remove-me" });

    await clearSessionData(session);

    expect({ ...session }).toEqual({ save: expect.any(Function) });
  });
});
