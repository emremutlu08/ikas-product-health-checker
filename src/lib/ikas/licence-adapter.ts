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

    const appSubscriptions: IkasAppSubscription[] = [];
    for (const candidate of parsed.data.appSubscriptions) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("authorizedAppId" in candidate) ||
        candidate.authorizedAppId !== authorizedAppId
      ) {
        continue;
      }

      const subscription = appSubscriptionSchema.safeParse(candidate);
      if (!subscription.success) {
        throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
      }
      appSubscriptions.push(subscription.data);
    }

    return { merchantId: parsed.data.merchantId, appSubscriptions };
  }
}
