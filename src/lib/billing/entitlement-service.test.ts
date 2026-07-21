import { describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError, IkasUpstreamError } from "../ikas/errors";
import {
  HttpIkasLicenceAdapter,
  type IkasAppSubscription,
  type IkasMerchantLicence,
} from "../ikas/licence-adapter";
import { PRO_PLAN_KEY } from "./plan-catalog";
import {
  isTerminallyDenied,
  mayApplyGrace,
  resolveEntitlement,
  resolveLiveEntitlement,
  type EntitlementSubject,
} from "./entitlement-service";

const INSTALLATION = { authorizedAppId: "app-install-1", merchantId: "merchant-1" };

function subscription(overrides: Partial<IkasAppSubscription> = {}): IkasAppSubscription {
  return {
    id: "sub-1",
    authorizedAppId: "app-install-1",
    storeAppId: "store-app-1",
    storeAppListingSubscriptionKey: PRO_PLAN_KEY,
    status: "ACTIVE",
    deleted: false,
    ...overrides,
  };
}

function licence(subscriptions: IkasAppSubscription[]): IkasMerchantLicence {
  return { merchantId: "merchant-1", appSubscriptions: subscriptions };
}

describe("resolveEntitlement", () => {
  it("grants Pro for an active, undeleted, known-key subscription on this exact installation", () => {
    expect(resolveEntitlement(licence([subscription()]), INSTALLATION)).toEqual({
      authorizedAppId: "app-install-1",
      merchantId: "merchant-1",
      tier: "pro",
      state: "active",
      planKey: PRO_PLAN_KEY,
      reason: "ACTIVE_KNOWN_PLAN",
    });
  });

  it("falls back to Free when the merchant has no app subscription at all", () => {
    expect(resolveEntitlement(licence([]), INSTALLATION)).toEqual({
      authorizedAppId: "app-install-1",
      merchantId: "merchant-1",
      tier: "free",
      state: "inactive",
      reason: "NO_MATCHING_SUBSCRIPTION",
    });
  });

  it("never grants Pro from a subscription belonging to another installation", () => {
    const foreign = [
      subscription({ authorizedAppId: "app-install-2" }),
      subscription({ authorizedAppId: null }),
      // storeAppId alone must not be treated as a match.
      subscription({ authorizedAppId: undefined as unknown as string, storeAppId: "store-app-1" }),
    ];

    for (const candidate of foreign) {
      const entitlement = resolveEntitlement(licence([candidate]), INSTALLATION);
      expect(entitlement.tier, JSON.stringify(candidate)).toBe("free");
      expect(entitlement.reason).toBe("NO_MATCHING_SUBSCRIPTION");
    }
  });

  it("never grants Pro for a non-active, deleted, or unknown-key subscription", () => {
    const cases: Array<[Partial<IkasAppSubscription>, string]> = [
      // Only the two non-active enum members are business states. A status outside the enum
      // is rejected upstream by the adapter schema, never resolved as a confirmed lapse here.
      [{ status: "WILL_BE_REMOVED" }, "SUBSCRIPTION_NOT_ACTIVE"],
      [{ status: "REMOVED" }, "SUBSCRIPTION_NOT_ACTIVE"],
      [{ deleted: true }, "SUBSCRIPTION_NOT_ACTIVE"],
    ];

    for (const [overrides, reason] of cases) {
      const entitlement = resolveEntitlement(licence([subscription(overrides)]), INSTALLATION);
      expect(entitlement.tier, JSON.stringify(overrides)).toBe("free");
      expect(entitlement.state).toBe("inactive");
      expect(entitlement.reason, JSON.stringify(overrides)).toBe(reason);
      expect(entitlement.merchantId).toBe("merchant-1");
    }
  });

  // A live subscription we cannot price is an operator problem, not a merchant downgrade:
  // the merchant is paying for something. Free is the safe serve, but the state stays
  // `unknown` so it is never recorded as a confirmed lapse.
  it("keeps a live subscription with an unrecognised plan key Free but unknown", () => {
    for (const key of ["product-health-pro-try-v2", ""]) {
      const entitlement = resolveEntitlement(
        licence([subscription({ storeAppListingSubscriptionKey: key })]),
        INSTALLATION,
      );

      expect(entitlement.tier, key).toBe("free");
      expect(entitlement.state, key).toBe("unknown");
      expect(entitlement.reason, key).toBe("UNKNOWN_PLAN_KEY");
      expect(entitlement.planKey, key).toBe(key);
      expect(mayApplyGrace(entitlement), key).toBe(false);
    }
  });

  it("picks the qualifying subscription out of a mixed list", () => {
    const entitlement = resolveEntitlement(
      licence([
        subscription({ authorizedAppId: "app-install-2" }),
        subscription({ storeAppListingSubscriptionKey: "future-plan" }),
        subscription({ status: "REMOVED" }),
        subscription(),
      ]),
      INSTALLATION,
    );

    expect(entitlement.tier).toBe("pro");
    expect(entitlement.state).toBe("active");
  });

  it("refuses to resolve when the licence belongs to a different merchant", () => {
    const entitlement = resolveEntitlement(
      { merchantId: "merchant-2", appSubscriptions: [subscription()] },
      INSTALLATION,
    );

    expect(entitlement).toEqual({
      authorizedAppId: "app-install-1",
      merchantId: "merchant-2",
      tier: "free",
      state: "denied",
      reason: "MERCHANT_MISMATCH",
    });
  });

  // `unknown` is the state a future cache/grace policy may soften. A licence answering for
  // another tenant is not a soft failure — it is a wrong answer, so it must be terminal and
  // must never reach any code path keyed on `unknown`.
  it("marks a cross-tenant answer terminal rather than retryable", () => {
    const mismatch = resolveEntitlement(
      { merchantId: "merchant-2", appSubscriptions: [subscription()] },
      INSTALLATION,
    );
    const malformed = resolveEntitlement(licence([subscription()]), {
      authorizedAppId: "app-install-1",
      merchantId: "   ",
    });

    for (const entitlement of [mismatch, malformed]) {
      expect(entitlement.state, entitlement.reason).toBe("denied");
      expect(entitlement.state, entitlement.reason).not.toBe("unknown");
      expect(isTerminallyDenied(entitlement)).toBe(true);
      expect(mayApplyGrace(entitlement)).toBe(false);
    }
  });

  it("default-denies malformed tenant subjects even if an upstream record matches them", () => {
    for (const subject of [
      { authorizedAppId: "", merchantId: "merchant-1" },
      { authorizedAppId: "   ", merchantId: "merchant-1" },
      { authorizedAppId: "app-install-1", merchantId: "" },
      { authorizedAppId: "app-install-1", merchantId: "   " },
    ]) {
      const matching = subscription({ authorizedAppId: subject.authorizedAppId });
      const entitlement = resolveEntitlement(licence([matching]), subject);

      expect(entitlement.tier, JSON.stringify(subject)).toBe("free");
      expect(entitlement.state).toBe("denied");
      expect(entitlement.reason).toBe("INVALID_SUBJECT");
    }
  });

  // Both bindings are mandatory: a subject that names only the installation cannot express
  // which tenant it expected, so it must never resolve a grant even when a record matches.
  it("default-denies a subject that omits merchantId at runtime", () => {
    const untyped = { authorizedAppId: "app-install-1" } as unknown as EntitlementSubject;

    const entitlement = resolveEntitlement(licence([subscription()]), untyped);

    expect(entitlement.tier).toBe("free");
    expect(entitlement.reason).toBe("INVALID_SUBJECT");
  });
});

describe("resolveLiveEntitlement", () => {
  it("returns the resolved entitlement from the injected adapter", async () => {
    const getMerchantLicence = vi.fn().mockResolvedValue(licence([subscription()]));

    await expect(resolveLiveEntitlement({ getMerchantLicence }, INSTALLATION)).resolves.toMatchObject({
      tier: "pro",
      state: "active",
      merchantId: "merchant-1",
    });
    expect(getMerchantLicence).toHaveBeenCalledWith("app-install-1");
  });

  it("default-denies an invalid subject before reading the licence", async () => {
    const getMerchantLicence = vi.fn();

    await expect(
      resolveLiveEntitlement({ getMerchantLicence }, { authorizedAppId: "   ", merchantId: "merchant-1" }),
    ).resolves.toMatchObject({ tier: "free", state: "denied", reason: "INVALID_SUBJECT" });
    expect(getMerchantLicence).not.toHaveBeenCalled();
  });

  it("warns once, structurally and secret-free, on an unrecognised plan key", async () => {
    const warn = vi.fn();
    const getMerchantLicence = vi
      .fn()
      .mockResolvedValue(
        licence([subscription({ storeAppListingSubscriptionKey: "product-health-pro-try-v2" })]),
      );

    const entitlement = await resolveLiveEntitlement({ getMerchantLicence }, INSTALLATION, {
      logger: { warn },
    });

    expect(entitlement).toMatchObject({ tier: "free", state: "unknown", reason: "UNKNOWN_PLAN_KEY" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      event: "billing.entitlement.unknown_plan_key",
      reason: "UNKNOWN_PLAN_KEY",
      authorizedAppId: "app-install-1",
      merchantId: "merchant-1",
      planKey: "product-health-pro-try-v2",
    });

    // The warning is diagnostics, not an audit log: it must carry no credential or payload.
    const serialized = JSON.stringify(warn.mock.calls[0]![0]);
    expect(serialized).not.toMatch(/token|bearer|authorization|password|secret/i);
    expect(Object.keys(warn.mock.calls[0]![0] as object)).toHaveLength(5);
  });

  it("stays silent and pure for a resolvable licence", async () => {
    const warn = vi.fn();
    const getMerchantLicence = vi.fn().mockResolvedValue(licence([subscription()]));

    await resolveLiveEntitlement({ getMerchantLicence }, INSTALLATION, { logger: { warn } });

    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves an unrecognised plan key without a logger injected", async () => {
    const getMerchantLicence = vi
      .fn()
      .mockResolvedValue(licence([subscription({ storeAppListingSubscriptionKey: "nope" })]));

    await expect(resolveLiveEntitlement({ getMerchantLicence }, INSTALLATION)).resolves.toMatchObject(
      { tier: "free", state: "unknown", reason: "UNKNOWN_PLAN_KEY" },
    );
  });

  // End-to-end for the enum decision: a status ikas has not declared must reach the caller as
  // an unresolvable licence, never as a confirmed inactive subscription that ends a paid plan.
  it("surfaces an undeclared upstream status as unknown, not as an inactive subscription", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            getMerchantLicence: {
              merchantId: "merchant-1",
              appSubscriptions: [
                {
                  id: "sub-1",
                  authorizedAppId: "app-install-1",
                  storeAppId: "store-app-1",
                  storeAppListingSubscriptionKey: PRO_PLAN_KEY,
                  status: "PAUSED",
                  deleted: false,
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    );
    const reader = new HttpIkasLicenceAdapter("https://example.test/graphql", "token", fetchMock);

    const entitlement = await resolveLiveEntitlement(reader, INSTALLATION);

    expect(entitlement.state).toBe("unknown");
    expect(entitlement.reason).toBe("LICENCE_INVALID_RESPONSE");
    expect(entitlement.state).not.toBe("inactive");
    expect(entitlement.tier).toBe("free");
  });

  it("classifies licence read failures without making auth or schema failures grace-eligible", async () => {
    const failures: Array<[unknown, string, boolean]> = [
      [new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED"), "LICENCE_AUTHENTICATION_FAILED", false],
      [new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR"), "LICENCE_NETWORK_UNAVAILABLE", true],
      [new IkasUpstreamError("IKAS_UPSTREAM_GRAPHQL_ERROR"), "LICENCE_INVALID_RESPONSE", false],
      [new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE"), "LICENCE_INVALID_RESPONSE", false],
      [new Error("unexpected"), "LICENCE_UNAVAILABLE", false],
    ];

    for (const [failure, reason, graceEligible] of failures) {
      const getMerchantLicence = vi.fn().mockRejectedValue(failure);
      const entitlement = await resolveLiveEntitlement({ getMerchantLicence }, INSTALLATION);

      expect(entitlement, String(failure)).toMatchObject({
        authorizedAppId: "app-install-1",
        merchantId: null,
        tier: "free",
        state: "unknown",
        reason,
      });
      expect(mayApplyGrace(entitlement), String(failure)).toBe(graceEligible);
    }
  });
});
