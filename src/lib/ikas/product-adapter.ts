import { sampleProducts } from "./sample-products";
import { IkasAuthenticationError, IkasUpstreamError } from "./errors";
import type { IkasProduct } from "./types";

export type ProductAdapterMode = "mock" | "http";

export type ProductAdapterResult = {
  source: ProductAdapterMode;
  products: IkasProduct[];
};

export interface IkasProductAdapter {
  listProducts(): Promise<ProductAdapterResult>;
}

export class MockIkasProductAdapter implements IkasProductAdapter {
  async listProducts(): Promise<ProductAdapterResult> {
    return { source: "mock", products: sampleProducts };
  }
}

const LIST_PRODUCT_QUERY = /* GraphQL */ `
  query listProduct($pagination: PaginationInput) {
    listProduct(pagination: $pagination) {
      count
      hasNext
      limit
      page
      data {
        id
        name
        createdAt
        updatedAt
        description
        shortDescription
        totalStock
        type
        deleted
        brand { id name }
        vendor { id name }
        categories { id name }
        tags { id name }
        salesChannels { id status }
        metaData { id slug }
        variants {
          id
          createdAt
          updatedAt
          sku
          barcodeList
          isActive
          sellIfOutOfStock
          deleted
          images { imageId fileName isMain isVideo order }
          prices { sellPrice discountPrice buyPrice currencyCode currencySymbol priceListId }
          stocks { id productId variantId stockLocationId stockCount deleted }
        }
      }
    }
  }
`;

type GraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
};

const AUTHENTICATION_GRAPHQL_CODES = new Set(["UNAUTHENTICATED", "LOGIN_REQUIRED"]);
export const PRODUCT_GRAPHQL_TIMEOUT_MS = 15_000;
export const PRODUCT_PAGE_LIMIT_MAX = 200;
export const PRODUCT_SCAN_MAX_PAGES = 50;
export const PRODUCT_SCAN_MAX_PRODUCTS = 10_000;
export const PRODUCT_SCAN_MAX_DURATION_MS = 45_000;

/**
 * Hard ceilings for a single catalog scan. Exceeding either budget is an error, never a
 * silently truncated report: a partial catalog would understate the real issue counts.
 */
export type ProductScanBudget = {
  maxPages?: number;
  maxProducts?: number;
  maxDurationMs?: number;
  now?: () => number;
};

function assertScanBudget(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED");
  }
  return value;
}

type ListProductResponse = {
  listProduct: {
    data: IkasProduct[];
    hasNext: boolean;
    page: number;
    limit: number;
  };
};

export class HttpIkasProductAdapter implements IkasProductAdapter {
  private readonly maxPages: number;
  private readonly maxProducts: number;
  private readonly maxDurationMs: number;
  private readonly now: () => number;

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly pageLimit = PRODUCT_PAGE_LIMIT_MAX,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = PRODUCT_GRAPHQL_TIMEOUT_MS,
    {
      maxPages = PRODUCT_SCAN_MAX_PAGES,
      maxProducts = PRODUCT_SCAN_MAX_PRODUCTS,
      maxDurationMs = PRODUCT_SCAN_MAX_DURATION_MS,
      now = () => performance.now(),
    }: ProductScanBudget = {},
  ) {
    if (assertScanBudget(pageLimit) > PRODUCT_PAGE_LIMIT_MAX) {
      throw new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED");
    }
    this.maxPages = assertScanBudget(maxPages);
    this.maxProducts = assertScanBudget(maxProducts);
    this.maxDurationMs = assertScanBudget(maxDurationMs);
    this.now = now;
  }

  async listProducts(): Promise<ProductAdapterResult> {
    const products: IkasProduct[] = [];
    let page = 1;
    let hasNext = true;
    const deadline = this.now() + this.maxDurationMs;

    while (hasNext) {
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        throw new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED");
      }

      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({
            query: LIST_PRODUCT_QUERY,
            variables: { pagination: { page, limit: this.pageLimit } },
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, remainingMs)),
        });
      } catch {
        if (this.now() >= deadline) {
          throw new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED");
        }
        throw new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR");
      }

      if (this.now() >= deadline) {
        throw new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED");
      }

      if (response.status === 401) throw new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED");
      if (!response.ok) throw new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR");

      let payload: GraphQlResponse<ListProductResponse>;
      try {
        payload = (await response.json()) as GraphQlResponse<ListProductResponse>;
      } catch {
        throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
      }
      if (this.now() >= deadline) {
        throw new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED");
      }
      if (payload.errors?.length) {
        const hasAuthenticationError = payload.errors.some((error) =>
          error.extensions?.code ? AUTHENTICATION_GRAPHQL_CODES.has(error.extensions.code) : false,
        );
        if (hasAuthenticationError) throw new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED");
        throw new IkasUpstreamError("IKAS_UPSTREAM_GRAPHQL_ERROR");
      }

      if (!payload.data?.listProduct) {
        throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
      }

      products.push(...payload.data.listProduct.data);
      if (products.length > this.maxProducts) {
        throw new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED");
      }

      hasNext = payload.data.listProduct.hasNext;
      if (hasNext && page >= this.maxPages) {
        throw new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED");
      }
      page += 1;
    }

    return { source: "http", products };
  }
}
