import { describe, expect, it } from "vitest";
import { PRO_PLAN_KEY, resolvePlanKey } from "./plan-catalog";

describe("resolvePlanKey", () => {
  it("maps the immutable pro listing key to the pro tier", () => {
    expect(PRO_PLAN_KEY).toBe("product-health-pro-try-v1");
    expect(resolvePlanKey(PRO_PLAN_KEY)).toEqual({
      known: true,
      planKey: "product-health-pro-try-v1",
      tier: "pro",
    });
  });

  it("default-denies every key outside the catalog", () => {
    for (const key of [
      "product-health-pro-try-v2",
      "PRODUCT-HEALTH-PRO-TRY-V1",
      " product-health-pro-try-v1 ",
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
    for (const key of [undefined, null, 42, {}, ["product-health-pro-try-v1"]]) {
      expect(resolvePlanKey(key)).toEqual({ known: false });
    }
  });
});
