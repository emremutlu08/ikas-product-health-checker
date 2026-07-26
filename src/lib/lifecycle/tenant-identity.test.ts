import { describe, expect, it } from "vitest";
import {
  TenantIdentityError,
  tenantDeletionKey,
  tenantDeletionMarker,
  validateTenantIdentity,
  type DeleteResult,
  type TenantIdentity,
} from "./tenant-identity";

describe("tenant identity", () => {
  it("returns only the two canonical validated identifiers", () => {
    expect(
      validateTenantIdentity({
        authorizedAppId: "authorized-app-1",
        merchantId: "merchant-1",
        accessToken: "must-not-survive",
      }),
    ).toEqual({
      authorizedAppId: "authorized-app-1",
      merchantId: "merchant-1",
    });
  });

  it.each([
    undefined,
    null,
    {},
    { authorizedAppId: "", merchantId: "merchant-1" },
    { authorizedAppId: "authorized-app-1", merchantId: "" },
    { authorizedAppId: "bad id", merchantId: "merchant-1" },
    { authorizedAppId: "authorized-app-1", merchantId: "bad\u0000id" },
    { authorizedAppId: "a".repeat(257), merchantId: "merchant-1" },
  ])("rejects an invalid identity before it can be used in a key: %#", (identity) => {
    expect(() => validateTenantIdentity(identity)).toThrow(TenantIdentityError);
  });

  it("exports the shared identity and deletion result contracts", () => {
    const identity: TenantIdentity = {
      authorizedAppId: "authorized-app-1",
      merchantId: "merchant-1",
    };
    const result: DeleteResult = "deleted";
    expect({ identity, result }).toEqual({
      identity,
      result: "deleted",
    });
  });

  it("derives stable opaque deletion keys by authorized app id alone", () => {
    const first = tenantDeletionKey("authorized-app-1");
    expect(first).toBe(tenantDeletionKey("authorized-app-1"));
    expect(first).not.toBe(tenantDeletionKey("authorized-app-2"));
    expect(first).not.toContain("authorized-app-1");
    expect(
      tenantDeletionMarker({
        authorizedAppId: "authorized-app-1",
        merchantId: "merchant-1",
      }),
    ).not.toContain("merchant-1");
  });
});
