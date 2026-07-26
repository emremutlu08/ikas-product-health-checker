import { IkasAuthenticationError } from "./errors";
import { IkasCircuitOpenError, sharedIkasRequestLimiter, type IkasRequestLimiter } from "./request-limiter";

/**
 * The only place in the application that sends a product mutation to ikas.
 *
 * Three operations are allowlisted, each with a fixed document and a fixed variable shape, so no
 * caller can widen the write surface by passing a different field. Nothing here retries: ikas
 * documents none of these mutations as idempotent, so a timed-out write is reported as an unknown
 * outcome and resolved by a source-of-truth read instead of being sent again.
 */

export const UPDATE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation updateProduct($input: UpdateProductInput!) {
    updateProduct(input: $input) {
      id
      updatedAt
    }
  }
`;

export const UPDATE_VARIANT_PRICES_MUTATION = /* GraphQL */ `
  mutation updateVariantPrices($input: UpdateVariantPricesInput!) {
    updateVariantPrices(input: $input) {
      errors {
        errorCode
        inputArrayIndex
      }
    }
  }
`;

export const SAVE_VARIANT_STOCKS_MUTATION = /* GraphQL */ `
  mutation saveVariantStocks($input: SaveVariantStocksInput!) {
    saveVariantStocks(input: $input) {
      errors {
        errorCode
        inputArrayIndex
      }
    }
  }
`;

export const PRODUCT_WRITE_TIMEOUT_MS = 20_000;
/** Well under the documented 3000-entry price ceiling; a chunk must stay small enough to reason about. */
export const MAX_WRITE_ITEMS_PER_CALL = 20;

export type ProductWriteOutcome =
  | { status: "applied" }
  | { status: "rejected"; errorCode: string };

export type ProductWriteErrorCode =
  | "unknown_outcome"
  | "rate_limited"
  | "circuit_open"
  | "invalid_request";

export class ProductWriteError extends Error {
  constructor(readonly code: ProductWriteErrorCode) {
    super(`IKAS_PRODUCT_WRITE_${code.toUpperCase()}`);
    this.name = "ProductWriteError";
  }
}

export type SkuWriteRequest = {
  productId: string;
  variants: Array<{ variantId: string; sku: string }>;
};

export type PriceWriteItem = {
  productId: string;
  variantId: string;
  /**
   * Re-sent verbatim from the live read. `updateVariantPrices` documents the supplied price object
   * as an override, so omitting a value that exists today would delete it.
   */
  sellPrice: number;
  buyPrice: number | null;
  discountPrice: number | null;
};

export type PriceWriteRequest = {
  priceListId: string | null;
  items: PriceWriteItem[];
};

export type StockWriteItem = {
  productId: string;
  variantId: string;
  stockLocationId: string;
  /** Absolute quantity to save, never a delta. */
  stockCount: number;
};

export interface IkasProductWriter {
  writeVariantSkus(request: SkuWriteRequest): Promise<ProductWriteOutcome[]>;
  writeVariantPrices(request: PriceWriteRequest): Promise<ProductWriteOutcome[]>;
  writeVariantStocks(items: StockWriteItem[]): Promise<ProductWriteOutcome[]>;
}

type GraphQlItemError = { errorCode?: unknown; inputArrayIndex?: unknown };

type GraphQlResponse<T> = {
  data?: T | null;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
};

const AUTHENTICATION_GRAPHQL_CODES = new Set(["UNAUTHENTICATED", "LOGIN_REQUIRED"]);

function assertItemCount(count: number) {
  if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_WRITE_ITEMS_PER_CALL) {
    throw new ProductWriteError("invalid_request");
  }
}

/**
 * Maps `{ errorCode, inputArrayIndex }` onto the exact submitted entries. An index the app cannot
 * place is treated as an unknown outcome for the whole call rather than as a success for the items
 * that happen to be unmentioned.
 */
export function applyItemErrors(count: number, errors: readonly GraphQlItemError[]): ProductWriteOutcome[] {
  const outcomes: ProductWriteOutcome[] = Array.from({ length: count }, () => ({ status: "applied" }));
  for (const error of errors) {
    const index = error.inputArrayIndex;
    const errorCode = error.errorCode;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      typeof errorCode !== "string" ||
      errorCode.length === 0 ||
      errorCode.length > 128
    ) {
      throw new ProductWriteError("unknown_outcome");
    }
    outcomes[index] = { status: "rejected", errorCode };
  }
  return outcomes;
}

export class HttpIkasProductWriter implements IkasProductWriter {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly limiter: IkasRequestLimiter = sharedIkasRequestLimiter(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = PRODUCT_WRITE_TIMEOUT_MS,
  ) {}

  private async execute<T>(query: string, variables: unknown): Promise<T> {
    const run = async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ query, variables }),
          cache: "no-store",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        // A transport failure after the request left the process proves nothing about the store.
        this.limiter.recordFailure();
        throw new ProductWriteError("unknown_outcome");
      }

      if (response.status === 429) {
        this.limiter.pauseFor(readRetryAfterMs(response));
        this.limiter.recordFailure();
        throw new ProductWriteError("rate_limited");
      }
      if (response.status === 401) {
        this.limiter.recordFailure();
        throw new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED");
      }
      if (!response.ok) {
        this.limiter.recordFailure();
        throw new ProductWriteError("unknown_outcome");
      }

      let payload: GraphQlResponse<T>;
      try {
        payload = (await response.json()) as GraphQlResponse<T>;
      } catch {
        this.limiter.recordFailure();
        throw new ProductWriteError("unknown_outcome");
      }

      if (payload.errors?.length) {
        const authenticationFailure = payload.errors.some((error) =>
          error.extensions?.code ? AUTHENTICATION_GRAPHQL_CODES.has(error.extensions.code) : false,
        );
        this.limiter.recordFailure();
        if (authenticationFailure) throw new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED");
        // ikas does not document whether a mutation-level error executed partially, so the result
        // is unknown and must be settled by a read-back, never by resending the mutation.
        throw new ProductWriteError("unknown_outcome");
      }
      if (payload.data === undefined || payload.data === null) {
        this.limiter.recordFailure();
        throw new ProductWriteError("unknown_outcome");
      }
      this.limiter.recordSuccess();
      return payload.data;
    };

    try {
      return await this.limiter.run(run);
    } catch (error) {
      if (error instanceof IkasCircuitOpenError) throw new ProductWriteError("circuit_open");
      throw error;
    }
  }

  async writeVariantSkus(request: SkuWriteRequest): Promise<ProductWriteOutcome[]> {
    assertItemCount(request.variants.length);
    await this.execute<{ updateProduct: { id: string } }>(UPDATE_PRODUCT_MUTATION, {
      input: {
        id: request.productId,
        variants: request.variants.map((variant) => ({ id: variant.variantId, sku: variant.sku })),
      },
    });
    // `updateProduct` has no per-item error channel; the read-back is the only per-variant proof.
    return request.variants.map(() => ({ status: "applied" }));
  }

  async writeVariantPrices(request: PriceWriteRequest): Promise<ProductWriteOutcome[]> {
    assertItemCount(request.items.length);
    const data = await this.execute<{ updateVariantPrices: { errors?: GraphQlItemError[] | null } }>(
      UPDATE_VARIANT_PRICES_MUTATION,
      {
        input: {
          ...(request.priceListId === null ? {} : { priceListId: request.priceListId }),
          variantPriceInputs: request.items.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            price: {
              sellPrice: item.sellPrice,
              ...(item.buyPrice === null ? {} : { buyPrice: item.buyPrice }),
              ...(item.discountPrice === null ? {} : { discountPrice: item.discountPrice }),
            },
          })),
        },
      },
    );
    return applyItemErrors(request.items.length, data.updateVariantPrices.errors ?? []);
  }

  async writeVariantStocks(items: StockWriteItem[]): Promise<ProductWriteOutcome[]> {
    assertItemCount(items.length);
    const data = await this.execute<{ saveVariantStocks: { errors?: GraphQlItemError[] | null } }>(
      SAVE_VARIANT_STOCKS_MUTATION,
      {
        input: {
          stockInputs: items.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            stockLocationId: item.stockLocationId,
            stockCount: item.stockCount,
          })),
        },
      },
    );
    return applyItemErrors(items.length, data.saveVariantStocks.errors ?? []);
  }
}

const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 10_000;

function readRetryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
}
