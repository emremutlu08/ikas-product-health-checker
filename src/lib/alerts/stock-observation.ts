import type { IkasProduct } from "@/lib/ikas/types";

/**
 * The per-location stock projection a scan produces on the side.
 *
 * Alerts are keyed by tenant, product, variant *and* stock location, which the health report does
 * not carry — it aggregates stock per variant. Rather than paying for a second catalog read, the
 * scan projects this compact view from the products it has already fetched.
 */

export const MAX_STOCK_OBSERVATIONS = 5_000;
const MAX_LABEL_LENGTH = 120;

export type StockObservation = {
  productId: string;
  productName: string;
  variantId: string;
  variantLabel?: string;
  stockLocationId: string;
  /** Absolute count for this one location, exactly as ikas reported it. */
  stockCount: number;
};

export type StockObservationSet = {
  observations: StockObservation[];
  /**
   * True when the catalog had more locations than the projection cap. Alert evaluation refuses to
   * run on a truncated view: a variant missing from the list would otherwise read as a recovery.
   */
  truncated: boolean;
};

function label(value: string) {
  return value.length > MAX_LABEL_LENGTH ? `${value.slice(0, MAX_LABEL_LENGTH - 1)}…` : value;
}

function variantLabelOf(product: IkasProduct, variantId: string) {
  if (product.variants.length <= 1) return undefined;
  const index = product.variants.findIndex((variant) => variant.id === variantId);
  return index >= 0 ? `Varyant ${index + 1}` : undefined;
}

export function collectStockObservations(
  products: readonly IkasProduct[],
  cap = MAX_STOCK_OBSERVATIONS,
): StockObservationSet {
  const observations: StockObservation[] = [];

  for (const product of products) {
    if (product.deleted) continue;
    for (const variant of product.variants) {
      if (variant.deleted || !variant.isActive) continue;
      for (const stock of variant.stocks ?? []) {
        if (stock.deleted) continue;
        if (!Number.isFinite(stock.stockCount)) continue;
        if (observations.length >= cap) return { observations, truncated: true };

        const variantLabel = variantLabelOf(product, variant.id);
        observations.push({
          productId: product.id,
          productName: label(product.name),
          variantId: variant.id,
          ...(variantLabel ? { variantLabel } : {}),
          stockLocationId: stock.stockLocationId,
          stockCount: stock.stockCount,
        });
      }
    }
  }

  return { observations, truncated: false };
}
