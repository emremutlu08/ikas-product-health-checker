import { describe, expect, it } from "vitest";
import { APP_FEATURES, isFeatureEnabled, minimumTierFor } from "./feature-policy";
import {
  CAPABILITY_CATALOG,
  catalogCoversEveryFeature,
  resolveCapabilityMatrix,
  type RolloutSignals,
  ROLLOUT_LABEL,
} from "./capability-catalog";

const activePro = { tier: "pro", state: "active" } as const;
const activeFree = { tier: "free", state: "active" } as const;

function signals(overrides: Partial<RolloutSignals> = {}): RolloutSignals {
  return {
    productWritesEnabled: false,
    bulkWritesEnabled: false,
    schedulerEnabled: false,
    emailDeliveryConfigured: false,
    verifiedRecipientConfigured: false,
    ...overrides,
  };
}

function capability(matrixSignals: RolloutSignals, feature: string, entitlement = activePro) {
  return resolveCapabilityMatrix(entitlement, matrixSignals).capabilities.find(
    (candidate) => candidate.feature === feature,
  )!;
}

describe("capability catalog", () => {
  it("gives every authorization feature exactly one merchant-facing record", () => {
    expect(catalogCoversEveryFeature()).toBe(true);
    expect(CAPABILITY_CATALOG).toHaveLength(APP_FEATURES.length);
  });

  it("has non-empty Turkish copy for every record", () => {
    for (const record of CAPABILITY_CATALOG) {
      expect(record.title.length, record.feature).toBeGreaterThan(3);
      expect(record.description.length, record.feature).toBeGreaterThan(20);
    }
  });

  it("takes each row's required tier from the policy rather than restating it", () => {
    for (const row of resolveCapabilityMatrix(activePro, signals()).capabilities) {
      expect(row.tier, row.feature).toBe(minimumTierFor(row.feature));
      expect(isFeatureEnabled(row.feature, row.tier), row.feature).toBe(true);
    }
  });

  it("never advertises a price, currency or trial", () => {
    const copy = JSON.stringify(CAPABILITY_CATALOG);
    for (const term of ["₺", "USD", "EUR", "/ay", "deneme süresi", "ücretsiz deneme"]) {
      expect(copy).not.toContain(term);
    }
  });
});

describe("resolveCapabilityMatrix", () => {
  it("shows correction capabilities as development-store limited while the kill switch is off", () => {
    const row = capability(signals(), "product-corrections-write");

    expect(row.rollout).toBe("development_store_only");
    expect(row.includedInPlan).toBe(true);
    expect(row.usableNow).toBe(false);
    expect(row.statusLabel).toBe("Geliştirme mağazasıyla sınırlı");
  });

  it("promotes corrections to beta only once the operator opens the flag", () => {
    const row = capability(signals({ productWritesEnabled: true }), "product-corrections-write");

    expect(row.rollout).toBe("beta");
    expect(row.usableNow).toBe(true);
  });

  it("keeps bulk closed until both switches are on", () => {
    expect(capability(signals({ productWritesEnabled: true }), "bulk-corrections-write").rollout).toBe(
      "development_store_only",
    );
    expect(
      capability(
        signals({ productWritesEnabled: true, bulkWritesEnabled: true }),
        "bulk-corrections-write",
      ).rollout,
    ).toBe("beta");
  });

  it("reports an unconfigured scheduler and email as needing configuration", () => {
    expect(capability(signals(), "scheduled-scan").rollout).toBe("needs_configuration");
    expect(capability(signals({ schedulerEnabled: true }), "daily-email-summary").rollout).toBe(
      "needs_configuration",
    );
    expect(
      capability(
        signals({
          schedulerEnabled: true,
          emailDeliveryConfigured: true,
          verifiedRecipientConfigured: true,
        }),
        "daily-email-summary",
      ).rollout,
    ).toBe("available");
  });

  it("holds low-stock alerts closed until they could actually be delivered", () => {
    // They share the daily summary's transport, so the scheduler alone is not enough.
    expect(capability(signals({ schedulerEnabled: true }), "low-stock-alerts").rollout).toBe(
      "needs_configuration",
    );
    expect(
      capability(
        signals({
          schedulerEnabled: true,
          emailDeliveryConfigured: true,
          verifiedRecipientConfigured: true,
        }),
        "low-stock-alerts",
      ).rollout,
    ).toBe("beta");
  });

  it("withholds every paid row from a Free merchant and labels it as a PRO capability", () => {
    const matrix = resolveCapabilityMatrix(activeFree, signals({ productWritesEnabled: true }));
    const paid = matrix.capabilities.filter((row) => row.tier === "pro");

    expect(paid.length).toBeGreaterThan(0);
    for (const row of paid) {
      expect(row.includedInPlan, row.feature).toBe(false);
      expect(row.usableNow, row.feature).toBe(false);
      expect(row.statusLabel, row.feature).toBe("PRO ile");
    }
  });

  it("treats an unreadable licence as Free rather than as an optimistic Pro", () => {
    const matrix = resolveCapabilityMatrix(
      { tier: "pro", state: "unknown" },
      signals({ productWritesEnabled: true }),
    );

    expect(matrix.tier).toBe("free");
    expect(matrix.entitlementActive).toBe(false);
    expect(matrix.capabilities.every((row) => !row.usableNow || row.tier === "free")).toBe(true);
    expect(
      matrix.capabilities.find((row) => row.feature === "manual-scan")!.statusLabel,
    ).toBe("Plan doğrulanamadı");
  });

  it("keeps Free capabilities usable for a Free merchant", () => {
    const matrix = resolveCapabilityMatrix(activeFree, signals());
    const free = matrix.capabilities.filter((row) => row.tier === "free");

    expect(free.map((row) => row.feature).sort()).toEqual(
      ["csv-export", "health-dashboard", "manual-scan"].sort(),
    );
    for (const row of free) expect(row.usableNow, row.feature).toBe(true);
  });
});

/**
 * The badge is derived from flags and constants, so its wording may not imply that anything was
 * observed running. It once read "Kullanımda" beside a paragraph claiming a feature is only marked
 * so after being verified in production — while three capabilities that had never executed carried
 * it. Wording is the whole safeguard here; without a test it drifted back into a claim.
 */
describe("capability status wording", () => {
  it("describes configuration, never observed behaviour", () => {
    const labels = Object.values(ROLLOUT_LABEL);

    expect(labels).toContain("Planınızda açık");
    for (const label of labels) {
      expect(label, label).not.toMatch(/kullanımda|çalışıyor|doğruland|test edildi/i);
    }
  });
});
