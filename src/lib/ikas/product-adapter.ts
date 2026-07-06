import { sampleProducts } from "./sample-products";
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
        description
        shortDescription
        totalStock
        type
        deleted
        brand { id name }
        vendor { id name }
        categories { id name }
        tags { id name }
        metaData { id slug }
        variants {
          id
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
  errors?: Array<{ message: string }>;
};

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
  ) {}

  async listProducts(): Promise<ProductAdapterResult> {
    const products: IkasProduct[] = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
      const response = await fetch(this.endpoint, {
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
      });

      if (!response.ok) {
        throw new Error(`ikas GraphQL request failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as GraphQlResponse<ListProductResponse>;
      if (payload.errors?.length) {
        throw new Error(`ikas GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
      }

      if (!payload.data?.listProduct) {
        throw new Error("ikas GraphQL response did not include listProduct data");
      }

      products.push(...payload.data.listProduct.data);
      hasNext = payload.data.listProduct.hasNext;
      page += 1;
    }

    return { source: "http", products };
  }
}

export function createProductAdapter(): IkasProductAdapter {
  const mode = process.env.IKAS_PRODUCT_ADAPTER ?? "mock";

  if (mode === "http") {
    const endpoint = process.env.IKAS_GRAPHQL_ENDPOINT;
    const token = process.env.IKAS_ADMIN_API_TOKEN;

    if (!endpoint || !token) {
      throw new Error("IKAS_PRODUCT_ADAPTER=http requires IKAS_GRAPHQL_ENDPOINT and IKAS_ADMIN_API_TOKEN");
    }

    return new HttpIkasProductAdapter(endpoint, token);
  }

  return new MockIkasProductAdapter();
}
