import type { IkasProduct, IkasProductVariant } from "@/lib/ikas/types";

/**
 * Anonymized catalog fixtures used only by tests.
 *
 * These are synthetic products, not sampled merchant data, and they make no claim about how
 * often any rule fails in a real store. Their only purpose is to hold *issue density* constant
 * while catalog size changes, so a scoring model can be checked for size comparability.
 *
 * Every fifth product is given the same fixed set of problems; everything else is clean. The
 * proportion of affected products and the issue mix per affected product are therefore
 * identical at 10, 100, and 1000 products.
 */

/** Weighted penalty one affected fixture product contributes: 2 critical, 2 warning, 2 info. */
export const AFFECTED_PRODUCT_ISSUE_MIX = {
  critical: 2,
  warning: 2,
  info: 2,
} as const;

/** One product in five carries the issue mix above. */
export const AFFECTED_PRODUCT_RATIO = 1 / 5;

function healthyVariant(index: number): IkasProductVariant {
  return {
    id: `variant-${index}`,
    updatedAt: "2026-07-01T00:00:00.000Z",
    sku: `SKU-${String(index).padStart(6, "0")}`,
    barcodeList: [`869${String(index).padStart(10, "0")}`],
    images: [{ imageId: `image-${index}`, fileName: `image-${index}.webp`, isMain: true }],
    isActive: true,
    sellIfOutOfStock: false,
    prices: [{ sellPrice: 100 + index, currencyCode: "TRY" }],
    stocks: [
      {
        id: `stock-${index}`,
        productId: `product-${index}`,
        variantId: `variant-${index}`,
        stockLocationId: "location-1",
        stockCount: 25,
        deleted: false,
      },
    ],
    deleted: false,
  };
}

/**
 * Missing SKU and missing price are critical; missing image and missing barcode are warnings;
 * missing brand and missing vendor are info. Description and category stay valid so the mix
 * stays exactly two of each severity.
 */
function affectedVariant(index: number): IkasProductVariant {
  return {
    ...healthyVariant(index),
    sku: null,
    barcodeList: [],
    images: [],
    prices: [],
  };
}

function fixtureProduct(index: number, affected: boolean): IkasProduct {
  return {
    id: `product-${index}`,
    updatedAt: "2026-07-01T00:00:00.000Z",
    // Unique per product so the duplicate-title rule never fires and density stays controlled.
    name: `Fixture ürün ${index}`,
    brand: affected ? null : { id: "brand-1", name: "Fixture marka" },
    vendor: affected ? null : { id: "vendor-1", name: "Fixture tedarikçi" },
    categories: [{ id: "category-1", name: "Fixture kategori" }],
    description: "Bu üründe geçerli ve yeterince uzun bir açıklama metni bulunuyor.",
    type: "PHYSICAL",
    deleted: false,
    variants: [affected ? affectedVariant(index) : healthyVariant(index)],
  };
}

/**
 * Builds `size` products where exactly `AFFECTED_PRODUCT_RATIO` of them carry the fixed issue
 * mix. `size` must be a multiple of 5 so the ratio is exact rather than rounded.
 */
export function buildCatalogFixture(size: number): IkasProduct[] {
  if (!Number.isSafeInteger(size) || size < 0 || size % 5 !== 0) {
    throw new Error(`catalog fixture size must be a non-negative multiple of 5, received ${size}`);
  }
  return Array.from({ length: size }, (_, index) => fixtureProduct(index, index % 5 === 0));
}

/** The three size bands the score model is compared across. */
export const CATALOG_FIXTURE_SIZES = [10, 100, 1000] as const;
