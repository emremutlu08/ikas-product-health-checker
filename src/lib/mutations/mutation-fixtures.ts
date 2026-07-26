import type { IkasProduct, IkasProductVariant } from "@/lib/ikas/types";
import type { MutationOperationPayload } from "./mutation-operation";

/**
 * Shared catalog shapes for mutation tests. Kept beside the code under test rather than duplicated
 * per suite so a schema change surfaces in one place.
 */

export const TEST_TENANT = {
  authorizedAppId: "authorized-app-1",
  merchantId: "merchant-1",
  storeName: "dev-store",
} as const;

export const PRODUCT_UPDATED_AT_MS = 1_753_000_000_000;
export const PRODUCT_UPDATED_AT_ISO = new Date(PRODUCT_UPDATED_AT_MS).toISOString();

export function buildVariant(overrides: Partial<IkasProductVariant> = {}): IkasProductVariant {
  return {
    id: "variant-1",
    sku: "OLD-SKU",
    barcodeList: ["869000000001"],
    images: [{ imageId: "image-1", fileName: "front.jpg", isMain: true, isVideo: false, order: 0 }],
    isActive: true,
    sellIfOutOfStock: false,
    deleted: false,
    updatedAt: PRODUCT_UPDATED_AT_MS,
    prices: [
      {
        sellPrice: 199.9,
        buyPrice: 120,
        discountPrice: 249.9,
        currencyCode: "TRY",
        currencySymbol: "₺",
        priceListId: null,
      },
    ],
    stocks: [
      {
        id: "stock-1",
        productId: "product-1",
        variantId: "variant-1",
        stockLocationId: "location-1",
        stockCount: 4,
        deleted: false,
      },
    ],
    ...overrides,
  };
}

export function buildProduct(overrides: Partial<IkasProduct> = {}): IkasProduct {
  return {
    id: "product-1",
    name: "Classic Laptop Sleeve",
    type: "PHYSICAL",
    deleted: false,
    description: "Uzun ve anlamlı bir ürün açıklaması burada yer alıyor.",
    brand: { id: "brand-1", name: "Acme" },
    vendor: { id: "vendor-1", name: "Acme Tedarik" },
    categories: [{ id: "category-1", name: "Çanta" }],
    tags: [{ id: "tag-1", name: "yeni" }],
    metaData: { id: "meta-1", slug: "classic-laptop-sleeve" },
    salesChannels: [{ id: "channel-1", status: "VISIBLE" }],
    totalStock: 4,
    updatedAt: PRODUCT_UPDATED_AT_MS,
    variants: [buildVariant()],
    ...overrides,
  };
}

export function buildSkuPayload(
  overrides: Partial<Extract<MutationOperationPayload, { kind: "sku_change" }>> = {},
): MutationOperationPayload {
  return {
    version: 2,
    operationId: "operation-1",
    origin: "single",
    kind: "sku_change",
    productId: "product-1",
    variantId: "variant-1",
    expectedProductUpdatedAt: PRODUCT_UPDATED_AT_ISO,
    expectedPreviousSku: "OLD-SKU",
    proposedSku: "NEW-SKU",
    createdAt: 1_753_000_100_000,
    expiresAt: 1_753_000_700_000,
    ...overrides,
  };
}

export function buildPricePayload(
  overrides: Partial<Extract<MutationOperationPayload, { kind: "price_change" }>> = {},
): MutationOperationPayload {
  return {
    version: 2,
    operationId: "operation-price-1",
    origin: "single",
    kind: "price_change",
    productId: "product-1",
    variantId: "variant-1",
    expectedProductUpdatedAt: PRODUCT_UPDATED_AT_ISO,
    priceListId: null,
    expectedSellPrice: 199.9,
    expectedBuyPrice: 120,
    expectedDiscountPrice: 249.9,
    proposedSellPrice: 149.9,
    createdAt: 1_753_000_100_000,
    expiresAt: 1_753_000_700_000,
    ...overrides,
  };
}

export function buildStockPayload(
  overrides: Partial<Extract<MutationOperationPayload, { kind: "stock_change" }>> = {},
): MutationOperationPayload {
  return {
    version: 2,
    operationId: "operation-stock-1",
    origin: "single",
    kind: "stock_change",
    productId: "product-1",
    variantId: "variant-1",
    expectedProductUpdatedAt: PRODUCT_UPDATED_AT_ISO,
    stockLocationId: "location-1",
    expectedStockCount: 4,
    proposedStockCount: 25,
    createdAt: 1_753_000_100_000,
    expiresAt: 1_753_000_700_000,
    ...overrides,
  };
}
