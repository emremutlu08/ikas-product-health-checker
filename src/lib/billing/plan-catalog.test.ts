import { describe, expect, it } from "vitest";
import { PRO_PLAN_KEY, PRO_PLAN_KEYS, resolvePlanKey } from "./plan-catalog";

describe("resolvePlanKey", () => {
  it("maps the immutable pro listing key to the pro tier", () => {
    expect(PRO_PLAN_KEY).toBe("productHealthPro");
    expect(resolvePlanKey(PRO_PLAN_KEY)).toEqual({
      known: true,
      planKey: "productHealthPro",
      tier: "pro",
    });
  });

  // One listing per currency, same product. A region missing here would leave a paying merchant
  // with no entitlement, because an unrecognised key default-denies rather than falling back.
  it("maps every regional pro listing to the same tier", () => {
    expect([...PRO_PLAN_KEYS]).toEqual([
      "productHealthPro",
      "productHealthProeu",
      "productHealthProus",
    ]);
    for (const key of PRO_PLAN_KEYS) {
      expect(resolvePlanKey(key), `expected pro for ${key}`).toEqual({
        known: true,
        planKey: key,
        tier: "pro",
      });
    }
  });

  it("default-denies every key outside the catalog", () => {
    for (const key of [
      "product-health-pro-try-v2",
      "PRODUCT-HEALTH-PRO-TRY-V1",
      " productHealthPro ",
      "free",
      "",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(resolvePlanKey(key), `expected default-deny for ${JSON.stringify(key)}`).toEqual({
        known: false,
      });
    }
  });

  it("default-denies non-string keys", () => {
    for (const key of [undefined, null, 42, {}, ["productHealthPro"]]) {
      expect(resolvePlanKey(key)).toEqual({ known: false });
    }
  });
});
