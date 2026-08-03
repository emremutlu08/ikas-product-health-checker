import { z } from "zod";
import { IkasAuthenticationError, IkasUpstreamError } from "./errors";

/**
 * Read-only view of `getMerchantLicence`. The query takes no arguments: ikas scopes the
 * result to the merchant behind the access token, so the caller must still check that the
 * returned merchant is the one it expected before trusting any subscription.
 */
const MERCHANT_LICENCE_QUERY = /* GraphQL */ `
  query getMerchantLicence {
    getMerchantLicence {
      merchantId
      appSubscriptions {
        id
        authorizedAppId
        storeAppId
        storeAppListingSubscriptionKey
        status
        deleted
      }
    }
  }
`;

/**
 * The exact values of `MerchantSubscriptionStatusEnum` as declared by the live ikas schema.
 *
 * Validated as a closed enum on purpose. A value outside this set is malformed upstream data,
 * not a fourth business state: parsing it as a plain string would let an ikas schema change
 * read as "not ACTIVE" and silently downgrade a paying merchant. Rejecting the read instead
 * surfaces it as an unknown licence, which never grants and never confirms a lapse.
 */
export const MERCHANT_SUBSCRIPTION_STATUS = {
  active: "ACTIVE",
  removed: "REMOVED",
  willBeRemoved: "WILL_BE_REMOVED",
} as const;

export const MERCHANT_SUBSCRIPTION_STATUSES = [
  MERCHANT_SUBSCRIPTION_STATUS.active,
  MERCHANT_SUBSCRIPTION_STATUS.removed,
  MERCHANT_SUBSCRIPTION_STATUS.willBeRemoved,
] as const;

/**
 * Upstream identifiers are opaque, so bound the length rather than guess a format. The bounds
 * only reject values no legitimate record would carry; they are not a validation of shape.
 */
export const MAX_IDENTIFIER_LENGTH = 256;
export const MAX_PLAN_KEY_LENGTH = 128;

/** Bounded identifier: never empty, never unbounded, so a malformed field cannot pass as data. */
const identifier = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);

const appSubscriptionSchema = z.object({
  id: identifier,
  // Nullable in the schema — an unauthorized-app record is data, not a malformed response.
  authorizedAppId: identifier.nullable(),
  storeAppId: identifier,
  // An empty listing key can never resolve to a tier, so it is rejected as malformed here
  // rather than travelling down to the catalog as an unknown-plan false alarm.
  storeAppListingSubscriptionKey: z.string().min(1).max(MAX_PLAN_KEY_LENGTH),
  status: z.enum(MERCHANT_SUBSCRIPTION_STATUSES),
  deleted: z.boolean(),
});

const merchantLicenceSchema = z.object({
  merchantId: identifier,
  // The list is nullable upstream, but null semantics are unverified. Treating it as an empty
  // list would silently read as "no subscription" (Free); it is rejected as unknown instead.
  appSubscriptions: z.array(z.unknown()),
});

export type IkasAppSubscription = z.infer<typeof appSubscriptionSchema>;
export type IkasMerchantLicence = {
  merchantId: string;
  appSubscriptions: IkasAppSubscription[];
  /**
   * How many subscriptions ikas returned, before any were parsed. A gap between this and
   * `appSubscriptions.length` means records were skipped as malformed, which is the difference
   * between "this merchant has no subscription" and "we could not read the one they have".
   */
  reportedSubscriptionCount: number;
};

export interface IkasLicenceAdapter {
  getMerchantLicence(authorizedAppId: string): Promise<IkasMerchantLicence>;
}

type GraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
};

/** Both names appear in the wild: `AbortError` for a caller abort, `TimeoutError` for ours. */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

const AUTHENTICATION_GRAPHQL_CODES = new Set(["UNAUTHENTICATED", "LOGIN_REQUIRED"]);
export const LICENCE_GRAPHQL_TIMEOUT_MS = 10_000;

export class HttpIkasLicenceAdapter implements IkasLicenceAdapter {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    /**
     * This app's listing id. Only used to tell our own malformed record — which must fail loudly
     * so the caller can grant grace — from another app's, which is simply not our business.
     */
    private readonly storeAppId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = LICENCE_GRAPHQL_TIMEOUT_MS,
  ) {}

  async getMerchantLicence(authorizedAppId: string): Promise<IkasMerchantLicence> {
    if (!identifier.safeParse(authorizedAppId).success || authorizedAppId.trim().length === 0) {
      throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ query: MERCHANT_LICENCE_QUERY }),
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR");
    }

    if (response.status === 401 || response.status === 403) {
      throw new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED");
    }
    if (!response.ok) {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR");
      }
      throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
    }

    let payload: GraphQlResponse<{ getMerchantLicence: unknown }>;
    try {
      payload = (await response.json()) as GraphQlResponse<{ getMerchantLicence: unknown }>;
    } catch (error) {
      // A body that stops arriving mid-read is a transport failure. Only a body that arrived
      // and did not parse is ikas sending us something malformed.
      if (isAbortError(error)) throw new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR");
      throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
    }

    if (payload.errors?.length) {
      const hasAuthenticationError = payload.errors.some((error) =>
        error.extensions?.code ? AUTHENTICATION_GRAPHQL_CODES.has(error.extensions.code) : false,
      );
      if (hasAuthenticationError) throw new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED");
      throw new IkasUpstreamError("IKAS_UPSTREAM_GRAPHQL_ERROR");
    }

    const parsed = merchantLicenceSchema.safeParse(payload.data?.getMerchantLicence);
    if (!parsed.success) {
      throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
    }

    /**
     * Every subscription the merchant holds is returned, unfiltered.
     *
     * This used to drop anything whose `authorizedAppId` did not equal the installation's — which
     * silently discarded the real thing: ikas leaves that field `null` on a plan bought through
     * "Planı Yönet", because no merchant app payment is involved. A paying merchant therefore
     * arrived here with an empty list and no way to tell "never subscribed" from "we threw it
     * away". Deciding which subscription belongs to this installation is the entitlement
     * resolver's job, and it needs to see the candidates to do it.
     */
    /**
     * Malformed data is fatal for this app's own subscription and ignorable for everyone else's.
     *
     * A merchant's licence lists every app they subscribe to. If one unrelated app's record
     * drifts from the documented shape, rejecting the whole licence would deny this merchant a
     * subscription they hold — an outage caused by someone else's data. But swallowing a
     * malformed record of *ours* is worse in the other direction: an ikas enum change would read
     * as "no subscription" and silently downgrade a paying merchant, instead of the unknown state
     * that grants grace. So the listing id decides which of the two rules applies.
     */
    const appSubscriptions: IkasAppSubscription[] = [];
    for (const candidate of parsed.data.appSubscriptions) {
      const subscription = appSubscriptionSchema.safeParse(candidate);
      if (subscription.success) {
        appSubscriptions.push(subscription.data);
        continue;
      }

      const isOurs =
        typeof candidate === "object" &&
        candidate !== null &&
        "storeAppId" in candidate &&
        candidate.storeAppId === this.storeAppId;
      if (isOurs) throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
    }

    return {
      merchantId: parsed.data.merchantId,
      appSubscriptions,
      reportedSubscriptionCount: parsed.data.appSubscriptions.length,
    };
  }
}
