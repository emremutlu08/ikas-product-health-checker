import type {
  IkasProduct,
  IkasProductPrice,
  IkasProductStockLocation,
  IkasProductVariant,
} from "./types";

/**
 * What a confirmed mutation is not allowed to touch.
 *
 * ikas does not document whether `updateProduct` with a single variant is a safe partial update,
 * so the app refuses to assume it. Every write captures a flattened, key-addressed view of the
 * whole product beforehand, re-captures it from the source of truth afterwards, and compares the
 * two with the one intended field removed. If anything else moved, the operation is reported as
 * unverified rather than successful — that is the evidence the canary is meant to produce, and
 * the same check keeps guarding production afterwards.
 *
 * Only path names ever leave this module. Values stay out of the return type so an audit record
 * or a log line can name what changed without carrying merchant catalog data.
 */

export type ProductInvariantSnapshot = {
  productId: string;
  /** Path -> canonical scalar rendering. Paths are stable across reorderings of any list. */
  fields: Record<string, string>;
};

export type MutationTargetPath =
  | { kind: "sku_change"; variantId: string }
  | { kind: "price_change"; variantId: string; priceListId: string | null }
  | { kind: "stock_change"; variantId: string; stockLocationId: string };

const DEFAULT_PRICE_LIST_KEY = "default";

/** Timestamps and derived totals legitimately move when an allowed field is written. */
const VOLATILE_SUFFIXES = ["updatedAt", "totalStock"] as const;

function scalar(value: unknown): string {
  if (value === undefined) return "u:";
  if (value === null) return "z:";
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number") return `n:${value}`;
  if (typeof value === "boolean") return `b:${value}`;
  return `j:${JSON.stringify(value)}`;
}

function put(fields: Record<string, string>, path: string, value: unknown) {
  fields[path] = scalar(value);
}

function priceListKey(priceListId: string | null | undefined) {
  return priceListId ?? DEFAULT_PRICE_LIST_KEY;
}

/** Stable ordering keys, so a reordered response is never mistaken for a changed one. */
function priceIdentity(price: IkasProductPrice) {
  return [
    priceListKey(price.priceListId),
    price.currencyCode ?? "",
    price.sellPrice ?? "",
    price.buyPrice ?? "",
    price.discountPrice ?? "",
  ].join("\u0000");
}

function stockIdentity(stock: IkasProductStockLocation) {
  // A live row sorts before its soft-deleted twin, so the target path always addresses the live one.
  return [stock.stockLocationId, stock.deleted ? "1" : "0", stock.id].join("\u0000");
}

function captureVariant(fields: Record<string, string>, variant: IkasProductVariant) {
  const base = `variant[${variant.id}]`;
  put(fields, `${base}.sku`, variant.sku ?? null);
  put(fields, `${base}.isActive`, variant.isActive);
  put(fields, `${base}.deleted`, variant.deleted);
  put(fields, `${base}.sellIfOutOfStock`, variant.sellIfOutOfStock ?? null);
  put(fields, `${base}.updatedAt`, variant.updatedAt ?? null);
  put(fields, `${base}.barcodeList`, [...(variant.barcodeList ?? [])].sort());

  const images = [...(variant.images ?? [])].sort((left, right) =>
    `${left.imageId ?? ""}${left.order ?? ""}`.localeCompare(`${right.imageId ?? ""}${right.order ?? ""}`),
  );
  put(fields, `${base}.images.count`, images.length);
  for (const image of images) {
    const imageBase = `${base}.image[${image.imageId ?? `order:${image.order ?? ""}`}]`;
    put(fields, `${imageBase}.fileName`, image.fileName ?? null);
    put(fields, `${imageBase}.isMain`, image.isMain ?? null);
    put(fields, `${imageBase}.isVideo`, image.isVideo ?? null);
    put(fields, `${imageBase}.order`, image.order ?? null);
  }

  /**
   * Prices and stocks can legitimately contain more than one row per price list or location — a
   * soft-deleted stock row sits beside its live replacement, and `planPriceChange` has a branch for
   * a duplicated default price list. Keying only by list/location would let the last row win, which
   * both hides a clobbered duplicate and turns a reordered response into a false violation. So the
   * rows are sorted deterministically and duplicates get a numbered suffix; the first row of each
   * group keeps the plain path the mutation target addresses.
   */
  const prices = [...(variant.prices ?? [])].sort((left, right) =>
    priceIdentity(left).localeCompare(priceIdentity(right)),
  );
  put(fields, `${base}.prices.count`, prices.length);
  const priceSeen = new Map<string, number>();
  for (const price of prices) {
    const group = priceListKey(price.priceListId);
    const seen = (priceSeen.get(group) ?? 0) + 1;
    priceSeen.set(group, seen);
    const priceBase = `${base}.price[${group}${seen === 1 ? "" : `#${seen}`}]`;
    put(fields, `${priceBase}.sellPrice`, price.sellPrice ?? null);
    put(fields, `${priceBase}.buyPrice`, price.buyPrice ?? null);
    put(fields, `${priceBase}.discountPrice`, price.discountPrice ?? null);
    put(fields, `${priceBase}.currencyCode`, price.currencyCode ?? null);
    put(fields, `${priceBase}.currencySymbol`, price.currencySymbol ?? null);
  }

  const stocks = [...(variant.stocks ?? [])].sort((left, right) =>
    stockIdentity(left).localeCompare(stockIdentity(right)),
  );
  put(fields, `${base}.stocks.count`, stocks.length);
  const stockSeen = new Map<string, number>();
  for (const stock of stocks) {
    const seen = (stockSeen.get(stock.stockLocationId) ?? 0) + 1;
    stockSeen.set(stock.stockLocationId, seen);
    const stockBase = `${base}.stock[${stock.stockLocationId}${seen === 1 ? "" : `#${seen}`}]`;
    put(fields, `${stockBase}.stockCount`, stock.stockCount);
    put(fields, `${stockBase}.deleted`, stock.deleted);
  }
}

export function captureProductInvariants(product: IkasProduct): ProductInvariantSnapshot {
  const fields: Record<string, string> = {};

  put(fields, "product.name", product.name);
  put(fields, "product.type", product.type);
  put(fields, "product.deleted", product.deleted);
  put(fields, "product.description", product.description ?? null);
  put(fields, "product.shortDescription", product.shortDescription ?? null);
  put(fields, "product.brand", product.brand?.id ?? null);
  put(fields, "product.vendor", product.vendor?.id ?? null);
  put(fields, "product.metaData.slug", product.metaData?.slug ?? null);
  put(fields, "product.updatedAt", product.updatedAt ?? null);
  put(fields, "product.totalStock", product.totalStock ?? null);
  put(
    fields,
    "product.categories",
    [...(product.categories ?? [])].map((category) => category.id).sort(),
  );
  put(fields, "product.tags", [...(product.tags ?? [])].map((tag) => tag.id).sort());
  put(
    fields,
    "product.salesChannels",
    [...(product.salesChannels ?? [])]
      .map((channel) => `${channel.id}:${channel.status ?? ""}`)
      .sort(),
  );
  put(fields, "product.variants.count", product.variants.length);
  put(fields, "product.variantIds", product.variants.map((variant) => variant.id).sort());

  for (const variant of product.variants) captureVariant(fields, variant);

  return { productId: product.id, fields };
}

/** The single path a confirmed operation is allowed to move. */
export function targetPath(target: MutationTargetPath): string {
  switch (target.kind) {
    case "sku_change":
      return `variant[${target.variantId}].sku`;
    case "price_change":
      return `variant[${target.variantId}].price[${priceListKey(target.priceListId)}].sellPrice`;
    case "stock_change":
      return `variant[${target.variantId}].stock[${target.stockLocationId}].stockCount`;
  }
}

function isVolatile(path: string) {
  return VOLATILE_SUFFIXES.some((suffix) => path.endsWith(`.${suffix}`));
}

/**
 * Paths that differ between the two reads, excluding the intended target and the timestamps that
 * ikas necessarily bumps. An empty result is the only shape that lets a write be called verified.
 */
export function diffProductInvariants(
  before: ProductInvariantSnapshot,
  after: ProductInvariantSnapshot,
  target: MutationTargetPath,
): string[] {
  if (before.productId !== after.productId) return ["product.id"];

  const allowed = targetPath(target);
  const changed = new Set<string>();
  for (const path of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    if (path === allowed || isVolatile(path)) continue;
    if (before.fields[path] !== after.fields[path]) changed.add(path);
  }
  return [...changed].sort();
}
