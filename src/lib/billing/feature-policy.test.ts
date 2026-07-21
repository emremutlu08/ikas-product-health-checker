import { describe, expect, it } from "vitest";
import { APP_FEATURES, isFeatureEnabled, listEnabledFeatures, type AppFeature } from "./feature-policy";

const FREE_FEATURES: AppFeature[] = ["manual-scan", "csv-export"];
const PRO_ONLY_FEATURES: AppFeature[] = [
  "scheduled-scan",
  "scan-history",
  "low-stock-threshold-config",
  "daily-email-summary",
];

describe("feature policy", () => {
  it("covers every declared feature exactly once", () => {
    expect([...APP_FEATURES].sort()).toEqual([...FREE_FEATURES, ...PRO_ONLY_FEATURES].sort());
  });

  it("keeps the shipped manual scan and CSV export on Free", () => {
    for (const feature of FREE_FEATURES) {
      expect(isFeatureEnabled(feature, "free"), feature).toBe(true);
      expect(isFeatureEnabled(feature, "pro"), feature).toBe(true);
    }
  });

  it("withholds every paid feature from Free", () => {
    for (const feature of PRO_ONLY_FEATURES) {
      expect(isFeatureEnabled(feature, "free"), feature).toBe(false);
      expect(isFeatureEnabled(feature, "pro"), feature).toBe(true);
    }
  });

  it("denies unknown features and unknown tiers", () => {
    expect(isFeatureEnabled("scan-history-v2" as AppFeature, "pro")).toBe(false);
    expect(isFeatureEnabled("__proto__" as AppFeature, "pro")).toBe(false);
    expect(isFeatureEnabled("manual-scan", "enterprise" as "pro")).toBe(false);
  });

  it("lists the features enabled for a tier", () => {
    expect([...listEnabledFeatures("free")].sort()).toEqual([...FREE_FEATURES].sort());
    expect([...listEnabledFeatures("pro")].sort()).toEqual([...APP_FEATURES].sort());
  });
});
