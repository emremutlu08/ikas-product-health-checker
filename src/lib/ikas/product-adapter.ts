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

type ListProductResponse = {
  listProduct: {
    data: IkasProduct[];
    hasNext: boolean;
    page: number;
    limit: number;
  };
};

export class HttpIkasProductAdapter implements IkasProductAdapter {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly pageLimit = 200,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = PRODUCT_GRAPHQL_TIMEOUT_MS,
  ) {}

  async listProducts(): Promise<ProductAdapterResult> {
    const products: IkasProduct[] = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
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
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR");
      }

      if (response.status === 401) throw new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED");
      if (!response.ok) throw new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR");

      let payload: GraphQlResponse<ListProductResponse>;
      try {
        payload = (await response.json()) as GraphQlResponse<ListProductResponse>;
      } catch {
        throw new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE");
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
      hasNext = payload.data.listProduct.hasNext;
      page += 1;
    }

    return { source: "http", products };
  }
}
