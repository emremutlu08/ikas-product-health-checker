import { describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError, IkasUpstreamError } from "./errors";
import {
  getProductHealthReport,
  type ProductHealthReportDependencies,
} from "./report-service";
import { TokenStoreError, type StoredIkasToken } from "./token-store";

const storedToken: StoredIkasToken = {
  authorizedAppId: "authorized-app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
  accessToken: "access-token",
};

const installation = {
  authorizedAppId: storedToken.authorizedAppId,
  merchantId: storedToken.merchantId!,
  storeName: storedToken.storeName!,
};

function createDependencies(listProducts = vi.fn().mockResolvedValue({ source: "http", products: [] })) {
  const getToken = vi.fn().mockResolvedValue(storedToken);
  const invalidateToken = vi.fn().mockResolvedValue(undefined);
  const createAdapter = vi.fn(() => ({ listProducts }));
  const dependencies = { getToken, invalidateToken, createAdapter } as unknown as ProductHealthReportDependencies;
  return { createAdapter, dependencies, getToken, invalidateToken, listProducts };
}

describe("getProductHealthReport authentication lifecycle", () => {
  it("keeps the runtime report path on the live HTTP adapter", async () => {
    const fixture = createDependencies();

    const result = await getProductHealthReport(
      new Date("2026-07-13T10:00:00.000Z"),
      installation,
      fixture.dependencies,
    );

    expect(result.source).toBe("http");
    expect(fixture.createAdapter).toHaveBeenCalledWith(expect.stringMatching(/^https:/), "access-token");
    expect(fixture.listProducts).toHaveBeenCalledOnce();
  });

  it("invalidates a token only after a confirmed API authentication failure", async () => {
    const fixture = createDependencies(
      vi.fn().mockRejectedValue(new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED")),
    );

    await expect(
      getProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toBeInstanceOf(IkasAuthenticationError);
    expect(fixture.invalidateToken).toHaveBeenCalledWith(storedToken.authorizedAppId, storedToken);
  });

  it("does not invalidate a token for a transient upstream failure", async () => {
    const fixture = createDependencies(
      vi.fn().mockRejectedValue(new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR")),
    );

    await expect(
      getProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toBeInstanceOf(IkasUpstreamError);
    expect(fixture.invalidateToken).not.toHaveBeenCalled();
  });

  it("does not turn a token-store backend failure into a missing-token response", async () => {
    const fixture = createDependencies();
    fixture.getToken.mockRejectedValue(new TokenStoreError("backend", "get"));

    await expect(
      getProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toMatchObject({ code: "backend", operation: "get" });
    expect(fixture.createAdapter).not.toHaveBeenCalled();
    expect(fixture.invalidateToken).not.toHaveBeenCalled();
  });

  it("requires an installation session before consulting the token store", async () => {
    const fixture = createDependencies();

    await expect(getProductHealthReport(new Date(), undefined, fixture.dependencies)).rejects.toMatchObject({
      code: "IKAS_LIVE_AUTH_REQUIRED",
    });
    expect(fixture.getToken).not.toHaveBeenCalled();
    expect(fixture.createAdapter).not.toHaveBeenCalled();
  });

  it("requires a matching durable token and never falls back to mock data", async () => {
    const fixture = createDependencies();
    fixture.getToken.mockResolvedValue(undefined);

    await expect(
      getProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toMatchObject({ code: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(fixture.getToken).toHaveBeenCalledWith(installation.authorizedAppId);
    expect(fixture.createAdapter).not.toHaveBeenCalled();
  });

  it.each([
    { merchantId: "merchant-2" },
    { storeName: "other-store" },
    { authorizedAppId: "authorized-app-2" },
  ])("rejects a persisted cross-tenant token before creating an API adapter: %j", async (override) => {
    const fixture = createDependencies();
    fixture.getToken.mockResolvedValue({ ...storedToken, ...override });

    await expect(
      getProductHealthReport(new Date(), installation, fixture.dependencies),
    ).rejects.toMatchObject({ code: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(fixture.createAdapter).not.toHaveBeenCalled();
    expect(fixture.invalidateToken).not.toHaveBeenCalled();
  });
});
