import { describe, expect, it, vi } from "vitest";
import { InstallationAuthError, type LaunchResolution } from "@/lib/ikas/installation-auth";
import { handleIkasLaunch, type IkasLaunchRouteDependencies } from "./handler";

const ORIGIN = "https://health.example.com";
const ERROR_ID = "11111111-1111-4111-8111-111111111111";
const launch = {
  storeName: "dev-emre2",
  merchantId: "merchant-1",
  timestamp: "1783936800000",
  signature: "a".repeat(64),
  authorizedAppId: "authorized-app-1",
};
const installation = {
  authorizedAppId: launch.authorizedAppId,
  merchantId: launch.merchantId,
  storeName: launch.storeName,
};

function request(overrides: Record<string, string> = {}) {
  const url = new URL("/api/auth/ikas", ORIGIN);
  const params = { ...launch, ...overrides };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return { request: { nextUrl: url } as never, url };
}

function dependencies(resolution: LaunchResolution) {
  const session = { save: vi.fn() };
  const values: IkasLaunchRouteDependencies = {
    getCanonicalOrigin: () => ORIGIN,
    getClientSecret: () => "client-secret",
    resolveLaunch: vi.fn().mockResolvedValue(resolution),
    getSession: vi.fn().mockResolvedValue(session) as never,
    saveInstallationSession: vi.fn().mockResolvedValue(undefined),
    createCorrelationId: () => ERROR_ID,
  };
  return { session, values };
}

describe("ikas launch route", () => {
  it("creates an installation session only after exact tenant resolution and cleans the URL", async () => {
    const fixture = dependencies({
      status: "authenticated",
      installation,
      token: { ...installation, accessToken: "access-token" },
    });

    const response = await handleIkasLaunch(request().request, fixture.values);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(response.headers.get("location")).not.toContain("authorizedAppId");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(fixture.values.saveInstallationSession).toHaveBeenCalledWith(
      fixture.session,
      installation,
    );
  });

  it("starts OAuth for the validated store without establishing an installation session", async () => {
    const fixture = dependencies({ status: "oauth_required", installation });

    const response = await handleIkasLaunch(request().request, fixture.values);

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/api/oauth/authorize/ikas?storeName=dev-emre2`,
    );
    expect(fixture.values.saveInstallationSession).not.toHaveBeenCalled();
  });

  it("fails closed on cross-tenant resolution without echoing tenant identifiers", async () => {
    const fixture = dependencies({ status: "oauth_required", installation });
    vi.mocked(fixture.values.resolveLaunch).mockRejectedValue(
      new InstallationAuthError("TENANT_MISMATCH"),
    );

    const response = await handleIkasLaunch(request().request, fixture.values);
    const location = response.headers.get("location")!;

    expect(location).toContain("status=fail");
    expect(location).toContain("reason=callback_invalid");
    expect(location).not.toContain(launch.authorizedAppId);
    expect(location).not.toContain(launch.merchantId);
    expect(fixture.values.saveInstallationSession).not.toHaveBeenCalled();
  });

  it("rejects missing or duplicate signed launch fields before tenant resolution", async () => {
    const fixture = dependencies({ status: "oauth_required", installation });
    const missing = request();
    missing.url.searchParams.delete("signature");
    const duplicate = request();
    duplicate.url.searchParams.append("merchantId", "attacker-merchant");

    const [missingResponse, duplicateResponse] = await Promise.all([
      handleIkasLaunch(missing.request, fixture.values),
      handleIkasLaunch(duplicate.request, fixture.values),
    ]);

    expect(missingResponse.headers.get("location")).toContain("reason=callback_invalid");
    expect(duplicateResponse.headers.get("location")).toContain("reason=callback_invalid");
    expect(fixture.values.resolveLaunch).not.toHaveBeenCalled();
    expect(fixture.values.saveInstallationSession).not.toHaveBeenCalled();
  });

  it("fails closed if the canonical origin is invalid", async () => {
    const fixture = dependencies({ status: "oauth_required", installation });
    fixture.values.getCanonicalOrigin = () => {
      throw new Error("bad origin");
    };

    const response = await handleIkasLaunch(request().request, fixture.values);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fixture.values.resolveLaunch).not.toHaveBeenCalled();
  });
});
