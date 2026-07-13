import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredIkasToken } from "./token-store";
import {
  getIkasLaunchAuthenticationHref,
  InstallationAuthError,
  readIkasLaunchParams,
  resolveIkasLaunch,
  validateIkasLaunchParams,
} from "./installation-auth";

const NOW = Date.parse("2026-07-13T10:00:00.000Z");
const APP_SECRET = "test-client-secret";

function buildLaunch(
  overrides: Partial<{
    storeName: string;
    merchantId: string;
    timestamp: string;
    signature: string;
    authorizedAppId: string;
  }> = {},
) {
  const storeName = overrides.storeName ?? "dev-emre2";
  const merchantId = overrides.merchantId ?? "merchant-1";
  const timestamp = overrides.timestamp ?? String(NOW);
  return {
    storeName,
    merchantId,
    timestamp,
    authorizedAppId: overrides.authorizedAppId ?? "authorized-app-1",
    signature:
      overrides.signature ??
      crypto
        .createHmac("sha256", APP_SECRET)
        .update(`${storeName}${merchantId}${timestamp}`)
        .digest("hex"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ikas signed launch validation", () => {
  it("uses the installed ikas signature helper after strict validation", () => {
    const validateSignature = vi.fn().mockReturnValue(true);
    const launch = buildLaunch();

    expect(
      validateIkasLaunchParams(launch, APP_SECRET, {
        now: () => NOW,
        validateSignature,
      }),
    ).toEqual(launch);
    expect(validateSignature).toHaveBeenCalledWith(launch, APP_SECRET);
  });

  it("accepts a fresh signature generated according to the installed helper contract", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(validateIkasLaunchParams(buildLaunch(), APP_SECRET)).toEqual(buildLaunch());
  });

  it.each([NOW - 120_001, NOW + 120_001])(
    "independently rejects a timestamp outside the past/future freshness window: %s",
    (timestamp) => {
      expect(() =>
        validateIkasLaunchParams(buildLaunch({ timestamp: String(timestamp) }), APP_SECRET, {
          now: () => NOW,
          validateSignature: () => true,
        }),
      ).toThrowError(expect.objectContaining({ code: "STALE_LAUNCH" }));
    },
  );

  it.each([
    { storeName: "dev-emre2\\@attacker.example" },
    { storeName: "dev-emre2@attacker.example" },
    { storeName: "dev-emre2\nattacker" },
    { storeName: "dev-emre2/attacker" },
    { authorizedAppId: "authorized/app" },
    { merchantId: "merchant\u0000attacker" },
  ])("rejects hostile non-canonical tenant data: %j", (override) => {
    expect(() =>
      validateIkasLaunchParams(buildLaunch(override), APP_SECRET, {
        now: () => NOW,
        validateSignature: () => true,
      }),
    ).toThrow(InstallationAuthError);
  });

  it("rejects duplicate launch parameters", () => {
    const query = new URLSearchParams(buildLaunch());
    query.append("authorizedAppId", "attacker-app");
    expect(() => readIkasLaunchParams(query)).toThrowError(
      expect.objectContaining({ code: "INVALID_LAUNCH" }),
    );
  });
});

describe("tenant resolution", () => {
  const storedToken: StoredIkasToken = {
    authorizedAppId: "authorized-app-1",
    merchantId: "merchant-1",
    storeName: "dev-emre2",
    accessToken: "access-token",
    refreshToken: "refresh-token",
  };

  it("requires the persisted app, merchant, and store to match before authentication", async () => {
    const getToken = vi.fn().mockResolvedValue(storedToken);
    await expect(
      resolveIkasLaunch(buildLaunch(), APP_SECRET, { getToken }, {
        now: () => NOW,
        validateSignature: () => true,
      }),
    ).resolves.toMatchObject({
      status: "authenticated",
      installation: {
        authorizedAppId: "authorized-app-1",
        merchantId: "merchant-1",
        storeName: "dev-emre2",
      },
    });
  });

  it.each([
    { merchantId: "merchant-2" },
    { storeName: "other-store" },
    { authorizedAppId: "authorized-app-2" },
  ])("rejects a cross-tenant persisted record: %j", async (tokenOverride) => {
    const getToken = vi.fn().mockResolvedValue({ ...storedToken, ...tokenOverride });
    await expect(
      resolveIkasLaunch(buildLaunch(), APP_SECRET, { getToken }, {
        now: () => NOW,
        validateSignature: () => true,
      }),
    ).rejects.toMatchObject({ code: "TENANT_MISMATCH" });
  });

  it("starts OAuth without creating an authenticated identity when no durable token exists", async () => {
    await expect(
      resolveIkasLaunch(buildLaunch(), APP_SECRET, {
        getToken: vi.fn().mockResolvedValue(undefined),
      }, {
        now: () => NOW,
        validateSignature: () => true,
      }),
    ).resolves.toMatchObject({ status: "oauth_required" });
  });
});

describe("root launch routing", () => {
  it("moves all launch fields to the dedicated validation handler", () => {
    const href = getIkasLaunchAuthenticationHref(buildLaunch());
    expect(href?.startsWith("/api/auth/ikas?")).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(href?.split("?")[1]))).toEqual(buildLaunch());
  });

  it("rejects an arbitrary authorizedAppId through the launch handler instead of using it as auth", () => {
    expect(getIkasLaunchAuthenticationHref({ authorizedAppId: "attacker-app" })).toBe(
      "/api/auth/ikas?authorizedAppId=attacker-app",
    );
  });

  it("does not intercept ordinary session-authenticated filter URLs", () => {
    expect(getIkasLaunchAuthenticationHref({ rule: "missing_sku" })).toBeUndefined();
  });
});
