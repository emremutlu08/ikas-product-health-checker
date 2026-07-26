import { z } from "zod";

/**
 * The durable shape of a single confirmed product mutation.
 *
 * Everything here is a scalar. The store keeps this payload as one opaque JSON string inside a
 * Redis hash and never decodes it in Lua, so no array/precision round-trip can silently rewrite a
 * price or a timestamp. Anything a Lua script must reason about — tenant marker, status, expiry —
 * lives in its own hash field instead.
 */

export const MUTATION_OPERATION_KINDS = ["sku_change", "price_change", "stock_change"] as const;
export type MutationOperationKind = (typeof MUTATION_OPERATION_KINDS)[number];

export const MUTATION_OPERATION_ORIGINS = ["single", "undo", "bulk"] as const;
export type MutationOperationOrigin = (typeof MUTATION_OPERATION_ORIGINS)[number];

export const MAX_SKU_LENGTH = 128;
export const MAX_STOCK_COUNT = 1_000_000;
export const MAX_SELL_PRICE = 100_000_000;

/**
 * ikas identifiers observed so far are UUIDs. The pattern stays deliberately narrow: an id is only
 * ever echoed back into a GraphQL variable or hashed into a Redis key, and neither should have to
 * defend against separators.
 */
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);

const isoTimestamp = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "invalid_timestamp" });

const epochMs = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Char-code test rather than a regex literal: no escape sequence to get mangled in transit. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const skuSchema = z
  .string()
  .min(1)
  .max(MAX_SKU_LENGTH)
  .refine((value) => value.trim() === value && !hasControlCharacter(value), {
    message: "invalid_sku",
  });

/**
 * Money is never computed here.
 *
 * ikas documents `sellPrice` as a `Float` but publishes no decimal or rounding contract, so the
 * app refuses to invent one: a proposed price is accepted only as an exact plain-decimal literal,
 * converted once, and afterwards proved by an exact read-back comparison. If the platform rounds
 * the value the read-back mismatches and the operation is reported as unverified rather than
 * quietly accepted.
 */
export const PRICE_LITERAL_PATTERN = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,4})?$/;

export function parsePriceLiteral(value: unknown): number | undefined {
  if (typeof value !== "string" || !PRICE_LITERAL_PATTERN.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_SELL_PRICE) return undefined;
  return parsed;
}

const money = z.number().finite().nonnegative().max(MAX_SELL_PRICE);
const stockCount = z.number().int().nonnegative().max(MAX_STOCK_COUNT);

const commonPayload = {
  version: z.literal(2),
  operationId: identifier,
  origin: z.enum(MUTATION_OPERATION_ORIGINS),
  productId: identifier,
  variantId: identifier,
  expectedProductUpdatedAt: isoTimestamp,
  createdAt: epochMs,
  expiresAt: epochMs,
  undoOfOperationId: identifier.optional(),
  batchId: identifier.optional(),
};

export const skuOperationPayloadSchema = z.object({
  ...commonPayload,
  kind: z.literal("sku_change"),
  expectedPreviousSku: skuSchema.nullable(),
  proposedSku: skuSchema,
});

export const priceOperationPayloadSchema = z.object({
  ...commonPayload,
  kind: z.literal("price_change"),
  /** `null` is the default price list, which ikas represents as an absent `priceListId`. */
  priceListId: identifier.nullable(),
  expectedSellPrice: money,
  expectedBuyPrice: money.nullable(),
  expectedDiscountPrice: money.nullable(),
  proposedSellPrice: money,
});

export const stockOperationPayloadSchema = z.object({
  ...commonPayload,
  kind: z.literal("stock_change"),
  stockLocationId: identifier,
  expectedStockCount: stockCount,
  /** Absolute quantity, never a delta: `saveVariantStocks` documents `stockCount` as the value to save. */
  proposedStockCount: stockCount,
});

export const mutationOperationPayloadSchema = z.discriminatedUnion("kind", [
  skuOperationPayloadSchema,
  priceOperationPayloadSchema,
  stockOperationPayloadSchema,
]);

/** The kind-specific half of an operation: what changes and what it is expected to be first. */
export type MutationIntent =
  | Pick<
      z.infer<typeof skuOperationPayloadSchema>,
      "kind" | "expectedPreviousSku" | "proposedSku"
    >
  | Pick<
      z.infer<typeof priceOperationPayloadSchema>,
      | "kind"
      | "priceListId"
      | "expectedSellPrice"
      | "expectedBuyPrice"
      | "expectedDiscountPrice"
      | "proposedSellPrice"
    >
  | Pick<
      z.infer<typeof stockOperationPayloadSchema>,
      "kind" | "stockLocationId" | "expectedStockCount" | "proposedStockCount"
    >;

export type SkuOperationPayload = z.infer<typeof skuOperationPayloadSchema>;
export type PriceOperationPayload = z.infer<typeof priceOperationPayloadSchema>;
export type StockOperationPayload = z.infer<typeof stockOperationPayloadSchema>;
export type MutationOperationPayload = z.infer<typeof mutationOperationPayloadSchema>;

/** Terminal outcomes where the catalog is known to be unchanged. */
export const MUTATION_REJECT_REASONS = [
  "product_missing",
  "variant_missing",
  "stale_product",
  "stale_value",
  "stock_location_missing",
  "price_row_missing",
  "write_rejected",
  "preflight_failed",
] as const;
export type MutationRejectReason = (typeof MUTATION_REJECT_REASONS)[number];

export const MUTATION_UNKNOWN_REASONS = [
  "mutation_outcome_unknown",
  "verification_failed",
  "invariant_violation",
] as const;
export type MutationUnknownReason = (typeof MUTATION_UNKNOWN_REASONS)[number];

export const mutationSettlementSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    completedAt: epochMs,
    /** The exact value proved by the post-write source-of-truth read, never the requested one. */
    verifiedValue: z.union([z.string().max(MAX_SKU_LENGTH), z.number().finite(), z.null()]),
  }),
  z.object({
    status: z.literal("rejected"),
    completedAt: epochMs,
    reason: z.enum(MUTATION_REJECT_REASONS),
  }),
  z.object({
    status: z.literal("failed_unknown"),
    completedAt: epochMs,
    reason: z.enum(MUTATION_UNKNOWN_REASONS),
  }),
]);

export type MutationSettlement = z.infer<typeof mutationSettlementSchema>;
export type MutationTerminalStatus = MutationSettlement["status"];
export type MutationOperationStatus = "prepared" | "executing" | MutationTerminalStatus;

export type MutationOperationRecord = {
  payload: MutationOperationPayload;
  status: MutationOperationStatus;
  claimedAt?: number;
  settlement?: MutationSettlement;
};

export function parseMutationOperationPayload(value: unknown): MutationOperationPayload | undefined {
  const parsed = mutationOperationPayloadSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (parsed.data.expiresAt <= parsed.data.createdAt) return undefined;
  return parsed.data;
}

export function parseMutationSettlement(value: unknown): MutationSettlement | undefined {
  const parsed = mutationSettlementSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The one-line description of what a confirmed operation is allowed to change. It exists so the
 * writer, the read-back and the audit all agree on a single target instead of each deriving one.
 */
export function describeOperationTarget(payload: MutationOperationPayload): string {
  switch (payload.kind) {
    case "sku_change":
      return "variant.sku";
    case "price_change":
      return payload.priceListId
        ? `variant.prices[priceListId=${payload.priceListId}].sellPrice`
        : "variant.prices[default].sellPrice";
    case "stock_change":
      return `variant.stocks[stockLocationId=${payload.stockLocationId}].stockCount`;
  }
}
