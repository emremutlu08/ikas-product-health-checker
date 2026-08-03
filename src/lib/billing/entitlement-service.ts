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
  /** This app's listing id — the ikas client id. Identifies which subscription is ours. */
  storeAppId: string;
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

/**
 * Emitted whenever a licence was read successfully and still granted nothing.
 *
 * Without this, the worst case in the whole billing path is also the quietest: a merchant pays,
 * the licence answers, no subscription matches, and the app serves Free with not one line
 * recorded anywhere. `subscriptionCount` separates "the merchant has no subscription at all"
 * from "they have one and this installation could not claim it", which are different bugs.
 */
export type NoEntitlementWarning = {
  event: "billing.entitlement.not_granted";
  reason: "MERCHANT_MISMATCH" | "NO_MATCHING_SUBSCRIPTION" | "SUBSCRIPTION_NOT_ACTIVE" | "INVALID_SUBJECT";
  authorizedAppId: string;
  merchantId: string | null;
  /** Subscriptions this app could read, before any of them were matched to this install. */
  subscriptionCount: number;
  /** What ikas reported. A gap from `subscriptionCount` means records could not be read at all. */
  reportedSubscriptionCount: number;
  /**
   * Why each candidate failed to grant, bounded to a handful.
   *
   * The point is to describe the upstream record rather than our verdict on it. A refusal that
   * only reports its own conclusion is what turned a bug in this file into a bug report filed
   * against ikas: the number said "no subscription" when it meant "none survived our filter".
   */
  candidates: Array<{
    storeAppIdMatches: boolean;
    authorizedAppIdMatches: boolean;
    authorizedAppIdIsNull: boolean;
    status: string;
    deleted: boolean;
  }>;
};

const MAX_LOGGED_CANDIDATES = 5;

function describeCandidates(licence: IkasMerchantLicence, subject: EntitlementSubject) {
  return licence.appSubscriptions.slice(0, MAX_LOGGED_CANDIDATES).map((subscription) => ({
    storeAppIdMatches: subscription.storeAppId === subject.storeAppId,
    authorizedAppIdMatches: subscription.authorizedAppId === subject.authorizedAppId,
    authorizedAppIdIsNull: subscription.authorizedAppId === null,
    status: subscription.status,
    deleted: subscription.deleted,
  }));
}

export type EntitlementLogger = {
  warn(warning: UnknownPlanKeyWarning | NoEntitlementWarning): void;
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

/**
 * Whether a subscription in this merchant's licence is a subscription to *this* app.
 *
 * The obvious field, `authorizedAppId`, is only populated when a merchant app payment created
 * the subscription. A plan bought through "Planı Yönet" leaves it `null`, so matching on it alone
 * refused every ordinary purchase — the exact failure this function was written to prevent, in
 * reverse. `storeAppId` is the app listing and is always present, which is what actually answers
 * the question.
 *
 * Matching on the listing is safe here and only here: the licence was fetched with this
 * installation's own token, and `resolveEntitlement` refuses outright unless the licence's
 * merchant is the subject's merchant. Both checks are load-bearing — drop either one and a
 * listing id, which is public and identical for every merchant, would start granting Pro.
 */
function belongsToInstallation(
  subscription: IkasAppSubscription,
  subject: EntitlementSubject,
) {
  if (subscription.storeAppId === subject.storeAppId) return true;

  return (
    typeof subscription.authorizedAppId === "string" &&
    subscription.authorizedAppId === subject.authorizedAppId
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

  // storeAppId is validated with the rest: an unset app listing id would make the match below
  // compare against `undefined`, and a missing binding must fail closed, not fall through.
  if (
    !isValidTenantIdentifier(subject.authorizedAppId) ||
    !isValidTenantIdentifier(subject.merchantId) ||
    !isValidTenantIdentifier(subject.storeAppId)
  ) {
    return { ...base, tier: "free", state: "denied", reason: "INVALID_SUBJECT" };
  }

  // Terminal, not unknown: the licence answered, it just answered for someone else.
  if (subject.merchantId !== licence.merchantId) {
    return { ...base, tier: "free", state: "denied", reason: "MERCHANT_MISMATCH" };
  }

  const owned = licence.appSubscriptions.filter((subscription) =>
    belongsToInstallation(subscription, subject),
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
  } else if (
    entitlement.reason === "MERCHANT_MISMATCH" ||
    entitlement.reason === "NO_MATCHING_SUBSCRIPTION" ||
    entitlement.reason === "SUBSCRIPTION_NOT_ACTIVE" ||
    entitlement.reason === "INVALID_SUBJECT"
  ) {
    options.logger?.warn({
      event: "billing.entitlement.not_granted",
      reason: entitlement.reason,
      authorizedAppId: entitlement.authorizedAppId,
      merchantId: entitlement.merchantId,
      subscriptionCount: licence.appSubscriptions.length,
      reportedSubscriptionCount: licence.reportedSubscriptionCount,
      candidates: describeCandidates(licence, subject),
    });
  }

  return entitlement;
}
