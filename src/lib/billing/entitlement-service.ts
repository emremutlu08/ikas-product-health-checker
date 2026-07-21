import {
  MAX_IDENTIFIER_LENGTH,
  MERCHANT_SUBSCRIPTION_STATUS,
  type IkasAppSubscription,
  type IkasMerchantLicence,
} from "../ikas/licence-adapter";
import { IkasAuthenticationError, IkasUpstreamError } from "../ikas/errors";
import { resolvePlanKey, type SemanticTier } from "./plan-catalog";

/**
 * `unknown` is not a softer `inactive`: it means the licence could not be established, so the
 * caller may retry or apply a future cache/grace policy.
 *
 * `denied` is terminal. It marks an answer that was read successfully but must never be
 * trusted — a licence for another tenant, or a subject too malformed to bind. Retrying or
 * softening those with cached state would hand one merchant another merchant's entitlement,
 * so they are deliberately kept out of `unknown`. Neither `unknown` nor `denied` grants Pro.
 */
export type EntitlementState = "active" | "inactive" | "unknown" | "denied";

/** Terminal: never retry, never soften, never serve from cache. */
export function isTerminallyDenied(entitlement: Entitlement): boolean {
  return entitlement.state === "denied";
}

/**
 * Grace is eligible only for a transient licence read failure. Other `unknown` reasons such as
 * an unmapped live plan are configuration failures and must remain fail-closed even if a caller
 * has cached Pro state.
 */
export function mayApplyGrace(entitlement: Entitlement): boolean {
  return entitlement.reason === "LICENCE_NETWORK_UNAVAILABLE";
}

export type EntitlementReason =
  | "ACTIVE_KNOWN_PLAN"
  | "NO_MATCHING_SUBSCRIPTION"
  | "SUBSCRIPTION_NOT_ACTIVE"
  | "UNKNOWN_PLAN_KEY"
  | "INVALID_SUBJECT"
  | "MERCHANT_MISMATCH"
  | "LICENCE_AUTHENTICATION_FAILED"
  | "LICENCE_NETWORK_UNAVAILABLE"
  | "LICENCE_INVALID_RESPONSE"
  | "LICENCE_UNAVAILABLE";

export type Entitlement = {
  authorizedAppId: string;
  /** From the licence itself, so callers can audit which tenant answered. Null when unreadable. */
  merchantId: string | null;
  tier: SemanticTier;
  state: EntitlementState;
  planKey?: string;
  reason: EntitlementReason;
};

/**
 * Both bindings are mandatory. An installation identity alone cannot say which tenant the
 * caller expected, so there would be no way to detect a licence answering for another
 * merchant. Callers must resolve the merchant before asking for an entitlement.
 */
export type EntitlementSubject = {
  authorizedAppId: string;
  /** The licence must belong to this merchant or nothing is granted. */
  merchantId: string;
};

/** Structural subset of IkasLicenceAdapter, so callers can inject any licence source. */
export type LicenceReader = {
  getMerchantLicence(authorizedAppId: string): Promise<IkasMerchantLicence>;
};

/**
 * Diagnostics only. Every field is an identifier the operator already owns — never a token,
 * a header, or an upstream response body, so the warning is safe for any log sink.
 */
export type UnknownPlanKeyWarning = {
  event: "billing.entitlement.unknown_plan_key";
  reason: "UNKNOWN_PLAN_KEY";
  authorizedAppId: string;
  merchantId: string | null;
  planKey: string;
};

export type EntitlementLogger = {
  warn(warning: UnknownPlanKeyWarning): void;
};

export type ResolveLiveEntitlementOptions = {
  /** Injected so the pure resolver stays IO-free and tests can assert the exact record. */
  logger?: EntitlementLogger;
};

function classifyLicenceFailure(error: unknown): EntitlementReason {
  if (error instanceof IkasAuthenticationError) return "LICENCE_AUTHENTICATION_FAILED";
  if (error instanceof IkasUpstreamError) {
    return error.code === "IKAS_UPSTREAM_HTTP_ERROR"
      ? "LICENCE_NETWORK_UNAVAILABLE"
      : "LICENCE_INVALID_RESPONSE";
  }
  return "LICENCE_UNAVAILABLE";
}

/** Runtime guard, not just a type: an untyped caller must not slip a missing binding through. */
function isValidTenantIdentifier(value: string) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

function belongsToInstallation(subscription: IkasAppSubscription, authorizedAppId: string) {
  // Exact authorizedAppId only. storeAppId identifies the listing, not this installation, so
  // matching on it would hand one merchant's subscription to another merchant's install.
  return (
    typeof subscription.authorizedAppId === "string" &&
    subscription.authorizedAppId === authorizedAppId
  );
}

function isLive(subscription: IkasAppSubscription) {
  return subscription.deleted === false && subscription.status === MERCHANT_SUBSCRIPTION_STATUS.active;
}

/**
 * Pure: a licence snapshot plus the subject it should apply to becomes an entitlement. No IO,
 * no cache, no clock — every non-granting path is explicit rather than a fallthrough.
 */
export function resolveEntitlement(
  licence: IkasMerchantLicence,
  subject: EntitlementSubject,
): Entitlement {
  const base = {
    authorizedAppId: subject.authorizedAppId,
    merchantId: licence.merchantId,
  };

  if (
    !isValidTenantIdentifier(subject.authorizedAppId) ||
    !isValidTenantIdentifier(subject.merchantId)
  ) {
    return { ...base, tier: "free", state: "denied", reason: "INVALID_SUBJECT" };
  }

  // Terminal, not unknown: the licence answered, it just answered for someone else.
  if (subject.merchantId !== licence.merchantId) {
    return { ...base, tier: "free", state: "denied", reason: "MERCHANT_MISMATCH" };
  }

  const owned = licence.appSubscriptions.filter((subscription) =>
    belongsToInstallation(subscription, subject.authorizedAppId),
  );
  if (owned.length === 0) {
    return { ...base, tier: "free", state: "inactive", reason: "NO_MATCHING_SUBSCRIPTION" };
  }

  const live = owned.filter(isLive);
  if (live.length === 0) {
    return { ...base, tier: "free", state: "inactive", reason: "SUBSCRIPTION_NOT_ACTIVE" };
  }

  for (const subscription of live) {
    const plan = resolvePlanKey(subscription.storeAppListingSubscriptionKey);
    if (plan.known) {
      return {
        ...base,
        tier: plan.tier,
        state: "active",
        planKey: plan.planKey,
        reason: "ACTIVE_KNOWN_PLAN",
      };
    }
  }

  // Live subscription, unrecognised listing key: serve Free rather than assume it is Pro, but
  // the state is `unknown`, never `inactive` — the merchant is paying for something and this
  // is our catalog being stale, not a confirmed lapse. `planKey` records the key we could not
  // price so the caller can report it; it is never a granted plan (the tier is Free).
  return {
    ...base,
    tier: "free",
    state: "unknown",
    planKey: live[0]!.storeAppListingSubscriptionKey,
    reason: "UNKNOWN_PLAN_KEY",
  };
}

/**
 * Reads the live licence through an injected adapter. Any failure — auth, network, GraphQL,
 * malformed payload — resolves to an unknown, Free entitlement instead of throwing, so a
 * caller can never mistake an outage for a paid customer.
 */
export async function resolveLiveEntitlement(
  reader: LicenceReader,
  subject: EntitlementSubject,
  options: ResolveLiveEntitlementOptions = {},
): Promise<Entitlement> {
  if (
    !isValidTenantIdentifier(subject.authorizedAppId) ||
    !isValidTenantIdentifier(subject.merchantId)
  ) {
    return {
      authorizedAppId: subject.authorizedAppId,
      merchantId: null,
      tier: "free",
      state: "denied",
      reason: "INVALID_SUBJECT",
    };
  }

  let licence: IkasMerchantLicence;
  try {
    licence = await reader.getMerchantLicence(subject.authorizedAppId);
  } catch (error) {
    return {
      authorizedAppId: subject.authorizedAppId,
      merchantId: null,
      tier: "free",
      state: "unknown",
      reason: classifyLicenceFailure(error),
    };
  }

  const entitlement = resolveEntitlement(licence, subject);

  // Emitted here, not in the resolver, so the resolver stays pure and side-effect free.
  if (entitlement.reason === "UNKNOWN_PLAN_KEY") {
    options.logger?.warn({
      event: "billing.entitlement.unknown_plan_key",
      reason: "UNKNOWN_PLAN_KEY",
      authorizedAppId: entitlement.authorizedAppId,
      merchantId: entitlement.merchantId,
      planKey: entitlement.planKey ?? "",
    });
  }

  return entitlement;
}
