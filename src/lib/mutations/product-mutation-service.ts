import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import {
  captureProductInvariants,
  diffProductInvariants,
  type MutationTargetPath,
} from "@/lib/ikas/product-invariants";
import { ProductWriteError, type IkasProductWriter, type ProductWriteOutcome } from "@/lib/ikas/product-writer";
import { canonicalIkasTimestamp } from "@/lib/ikas/timestamps";
import type { IkasProduct, IkasProductVariant } from "@/lib/ikas/types";
import {
  type MutationOperationPayload,
  type MutationRejectReason,
  type MutationSettlement,
  type MutationUnknownReason,
} from "./mutation-operation";
import type { MutationOperationStore } from "./mutation-operation-store";

/**
 * Executing a confirmed correction.
 *
 * The order is fixed and every step is a gate: kill switch, live entitlement, one-time atomic
 * claim, exact live preflight, exactly one write, exact source-of-truth read-back, whole-product
 * invariant comparison, durable settlement. A write whose outcome is unknown is never repeated —
 * it is resolved by reading the store again, which can only end in "it landed" or "it did not".
 */

export type MutationExecutionErrorCode =
  | "write_disabled"
  | "feature_required"
  | "confirmation_missing"
  | "confirmation_expired"
  | "confirmation_replay"
  | MutationRejectReason
  | MutationUnknownReason
  | "rate_limited"
  | "origin_not_allowed";

export class MutationExecutionError extends Error {
  constructor(readonly code: MutationExecutionErrorCode) {
    super(code);
    this.name = "MutationExecutionError";
  }
}

export type MutationExecutionResult = {
  status: "succeeded";
  operationId: string;
  kind: MutationOperationPayload["kind"];
  verifiedValue: string | number | null;
};

export type MutationExecutionDependencies = {
  /** Server-only kill switch. Default-off is decided by the caller, never by this module. */
  writesEnabled(): boolean;
  hasWriteFeature(installation: InstallationIdentity): Promise<boolean>;
  operationStore: Pick<MutationOperationStore, "claim" | "settle" | "get">;
  readProduct(productId: string): Promise<IkasProduct | undefined>;
  writer: IkasProductWriter;
  now(): number;
  /**
   * Which operations this caller may execute. The single-correction route refuses a bulk item, so
   * a planned batch cannot be driven one row at a time past the separate bulk kill switch — or
   * after the batch it belongs to has been cancelled.
   */
  acceptsOrigin?(origin: MutationOperationPayload["origin"]): boolean;
};

export function targetPathOf(payload: MutationOperationPayload): MutationTargetPath {
  switch (payload.kind) {
    case "sku_change":
      return { kind: "sku_change", variantId: payload.variantId };
    case "price_change":
      return {
        kind: "price_change",
        variantId: payload.variantId,
        priceListId: payload.priceListId,
      };
    case "stock_change":
      return {
        kind: "stock_change",
        variantId: payload.variantId,
        stockLocationId: payload.stockLocationId,
      };
  }
}

function activeVariant(product: IkasProduct, variantId: string): IkasProductVariant | undefined {
  return product.variants.find((candidate) => candidate.id === variantId && !candidate.deleted);
}

type ObservedValue =
  | { found: true; value: string | number | null }
  | { found: false; reason: Extract<MutationRejectReason, "price_row_missing" | "stock_location_missing"> };

/** The exact live value of the one field the operation targets. */
export function observeTargetValue(
  variant: IkasProductVariant,
  payload: MutationOperationPayload,
): ObservedValue {
  if (payload.kind === "sku_change") {
    return { found: true, value: variant.sku ?? null };
  }
  if (payload.kind === "price_change") {
    const row = (variant.prices ?? []).find(
      (price) => (price.priceListId ?? null) === payload.priceListId,
    );
    if (!row || typeof row.sellPrice !== "number") return { found: false, reason: "price_row_missing" };
    return { found: true, value: row.sellPrice };
  }
  const row = (variant.stocks ?? []).find(
    (stock) => stock.stockLocationId === payload.stockLocationId && !stock.deleted,
  );
  if (!row) return { found: false, reason: "stock_location_missing" };
  return { found: true, value: row.stockCount };
}

/**
 * Whether the live row still matches everything the merchant was shown. For a price this covers
 * the whole row, not just the sell price: `updateVariantPrices` overrides the price object, so a
 * buy or discount price that moved since the preview would be clobbered by re-sending the old one.
 */
function baselineMatches(variant: IkasProductVariant, payload: MutationOperationPayload): boolean {
  if (payload.kind === "sku_change") {
    return (variant.sku ?? null) === payload.expectedPreviousSku;
  }
  if (payload.kind === "price_change") {
    const row = (variant.prices ?? []).find(
      (price) => (price.priceListId ?? null) === payload.priceListId,
    );
    return Boolean(
      row &&
        row.sellPrice === payload.expectedSellPrice &&
        (row.buyPrice ?? null) === payload.expectedBuyPrice &&
        (row.discountPrice ?? null) === payload.expectedDiscountPrice,
    );
  }
  const row = (variant.stocks ?? []).find(
    (stock) => stock.stockLocationId === payload.stockLocationId && !stock.deleted,
  );
  return Boolean(row && row.stockCount === payload.expectedStockCount);
}

export function proposedValueOf(payload: MutationOperationPayload): string | number {
  switch (payload.kind) {
    case "sku_change":
      return payload.proposedSku;
    case "price_change":
      return payload.proposedSellPrice;
    case "stock_change":
      return payload.proposedStockCount;
  }
}

function expectedValueOf(payload: MutationOperationPayload): string | number | null {
  switch (payload.kind) {
    case "sku_change":
      return payload.expectedPreviousSku;
    case "price_change":
      return payload.expectedSellPrice;
    case "stock_change":
      return payload.expectedStockCount;
  }
}

async function performWrite(
  payload: MutationOperationPayload,
  writer: IkasProductWriter,
): Promise<ProductWriteOutcome> {
  if (payload.kind === "sku_change") {
    const [outcome] = await writer.writeVariantSkus({
      productId: payload.productId,
      variants: [{ variantId: payload.variantId, sku: payload.proposedSku }],
    });
    return outcome!;
  }
  if (payload.kind === "price_change") {
    const [outcome] = await writer.writeVariantPrices({
      priceListId: payload.priceListId,
      items: [
        {
          productId: payload.productId,
          variantId: payload.variantId,
          sellPrice: payload.proposedSellPrice,
          buyPrice: payload.expectedBuyPrice,
          discountPrice: payload.expectedDiscountPrice,
        },
      ],
    });
    return outcome!;
  }
  const [outcome] = await writer.writeVariantStocks([
    {
      productId: payload.productId,
      variantId: payload.variantId,
      stockLocationId: payload.stockLocationId,
      stockCount: payload.proposedStockCount,
    },
  ]);
  return outcome!;
}

export type VerificationOutcome =
  | { status: "succeeded"; verifiedValue: string | number | null }
  | { status: "rejected"; reason: MutationRejectReason }
  | { status: "failed_unknown"; reason: MutationUnknownReason };

/**
 * Reads the product again and decides what actually happened. This is the only function allowed to
 * conclude that a write succeeded, and it is also the reconciliation path for an unknown outcome:
 * either the intended value is live and nothing else moved, or it is not.
 */
export async function verifyAgainstSourceOfTruth(
  payload: MutationOperationPayload,
  before: ReturnType<typeof captureProductInvariants>,
  dependencies: Pick<MutationExecutionDependencies, "readProduct">,
): Promise<VerificationOutcome> {
  let product: IkasProduct | undefined;
  try {
    product = await dependencies.readProduct(payload.productId);
  } catch {
    return { status: "failed_unknown", reason: "mutation_outcome_unknown" };
  }
  if (!product || product.deleted) {
    return { status: "failed_unknown", reason: "mutation_outcome_unknown" };
  }
  const variant = activeVariant(product, payload.variantId);
  if (!variant) return { status: "failed_unknown", reason: "mutation_outcome_unknown" };

  const observed = observeTargetValue(variant, payload);
  if (!observed.found) return { status: "failed_unknown", reason: "verification_failed" };

  const changedPaths = diffProductInvariants(before, captureProductInvariants(product), targetPathOf(payload));
  if (changedPaths.length > 0) {
    return { status: "failed_unknown", reason: "invariant_violation" };
  }

  if (observed.value === proposedValueOf(payload)) {
    return { status: "succeeded", verifiedValue: observed.value };
  }
  if (observed.value === expectedValueOf(payload)) {
    // The catalog is provably untouched, so this is a terminal "did not apply", not an unknown.
    return { status: "rejected", reason: "write_rejected" };
  }
  return { status: "failed_unknown", reason: "verification_failed" };
}

function settlementFor(outcome: VerificationOutcome, completedAt: number): MutationSettlement {
  if (outcome.status === "succeeded") {
    return { status: "succeeded", completedAt, verifiedValue: outcome.verifiedValue };
  }
  if (outcome.status === "rejected") {
    return { status: "rejected", completedAt, reason: outcome.reason };
  }
  return { status: "failed_unknown", completedAt, reason: outcome.reason };
}

type FailedSettlement = Exclude<MutationSettlement, { status: "succeeded" }>;

async function settleAndThrow(
  installation: InstallationIdentity,
  operationId: string,
  settlement: FailedSettlement,
  dependencies: MutationExecutionDependencies,
  reportedCode?: MutationExecutionErrorCode,
): Promise<never> {
  try {
    await dependencies.operationStore.settle(installation, operationId, settlement);
  } catch {
    // The claimed operation stays claimed, so it still blocks replay even without a durable audit.
  }
  throw new MutationExecutionError(reportedCode ?? settlement.reason);
}

export async function executeConfirmedMutation(
  installation: InstallationIdentity,
  operationId: string,
  dependencies: MutationExecutionDependencies,
): Promise<MutationExecutionResult> {
  if (!dependencies.writesEnabled()) throw new MutationExecutionError("write_disabled");
  if (!(await dependencies.hasWriteFeature(installation))) {
    throw new MutationExecutionError("feature_required");
  }

  if (dependencies.acceptsOrigin) {
    // Checked before the claim, so refusing here does not consume the merchant's confirmation.
    const existing = await dependencies.operationStore.get(installation, operationId);
    if (existing && !dependencies.acceptsOrigin(existing.payload.origin)) {
      throw new MutationExecutionError("origin_not_allowed");
    }
  }

  const claim = await dependencies.operationStore.claim(installation, operationId, dependencies.now());
  if (claim.outcome !== "claimed") {
    throw new MutationExecutionError(
      (
        {
          missing: "confirmation_missing",
          expired: "confirmation_expired",
          replay: "confirmation_replay",
        } as const
      )[claim.outcome],
    );
  }
  const payload = claim.payload;

  let product: IkasProduct | undefined;
  try {
    product = await dependencies.readProduct(payload.productId);
  } catch {
    return settleAndThrow(
      installation,
      operationId,
      { status: "rejected", completedAt: dependencies.now(), reason: "preflight_failed" },
      dependencies,
    );
  }

  const reject = (reason: MutationRejectReason) =>
    settleAndThrow(
      installation,
      operationId,
      { status: "rejected", completedAt: dependencies.now(), reason },
      dependencies,
    );

  if (!product || product.deleted) return reject("product_missing");
  // ikas returns epoch milliseconds while the confirmation stores the canonical ISO form; the
  // guard compares the two only after both are normalised.
  if (canonicalIkasTimestamp(product.updatedAt) !== payload.expectedProductUpdatedAt) {
    return reject("stale_product");
  }
  const variant = activeVariant(product, payload.variantId);
  if (!variant) return reject("variant_missing");
  const observed = observeTargetValue(variant, payload);
  if (!observed.found) return reject(observed.reason);
  if (!baselineMatches(variant, payload)) return reject("stale_value");

  const before = captureProductInvariants(product);

  let writeOutcome: ProductWriteOutcome;
  try {
    writeOutcome = await performWrite(payload, dependencies.writer);
  } catch (error) {
    const writeErrorCode = error instanceof ProductWriteError ? error.code : undefined;
    if (writeErrorCode === "circuit_open" || writeErrorCode === "invalid_request") {
      // The limiter refused before anything left the process, so nothing can have been applied.
      return reject("preflight_failed");
    }

    // Every other failure — timeout, transport error, 429, upstream error — may or may not have
    // reached ikas. The catalog decides, never a second attempt.
    const outcome = await verifyAgainstSourceOfTruth(payload, before, dependencies);
    if (outcome.status === "succeeded") {
      return finish(installation, operationId, payload, outcome, dependencies);
    }
    return settleAndThrow(
      installation,
      operationId,
      settlementFor(outcome, dependencies.now()) as FailedSettlement,
      dependencies,
      writeErrorCode === "rate_limited" && outcome.status === "rejected" ? "rate_limited" : undefined,
    );
  }

  const outcome = await verifyAgainstSourceOfTruth(payload, before, dependencies);
  if (writeOutcome.status === "rejected" && outcome.status === "succeeded") {
    // ikas reported an item error yet the proposed value is live. Something else wrote it, or the
    // call applied partially; either way the operation is not a verified success.
    return settleAndThrow(
      installation,
      operationId,
      { status: "failed_unknown", completedAt: dependencies.now(), reason: "verification_failed" },
      dependencies,
    );
  }
  if (outcome.status !== "succeeded") {
    return settleAndThrow(
      installation,
      operationId,
      settlementFor(outcome, dependencies.now()) as FailedSettlement,
      dependencies,
    );
  }
  return finish(installation, operationId, payload, outcome, dependencies);
}

async function finish(
  installation: InstallationIdentity,
  operationId: string,
  payload: MutationOperationPayload,
  outcome: Extract<VerificationOutcome, { status: "succeeded" }>,
  dependencies: MutationExecutionDependencies,
): Promise<MutationExecutionResult> {
  const settled = await dependencies.operationStore.settle(
    installation,
    operationId,
    settlementFor(outcome, dependencies.now()),
  );
  if (settled !== "settled") throw new MutationExecutionError("verification_failed");
  return {
    status: "succeeded",
    operationId,
    kind: payload.kind,
    verifiedValue: outcome.verifiedValue,
  };
}

/**
 * An `executing` record older than this is assumed to have lost its request.
 *
 * The floor has to clear the slowest legitimate path from claim to settlement, not merely feel
 * long: a `429` can pause the limiter for a minute before the write is even sent, the write itself
 * has a 20s timeout, and the read-back after it has its own. Reconciling sooner would let a status
 * poll read the catalog before a still-in-flight write lands and settle it as "nothing changed".
 */
export const RECONCILE_MIN_AGE_MS = 5 * 60_000;

export type ReconciliationResult =
  | { status: "settled"; outcome: MutationSettlement["status"] }
  | { status: "not_applicable" };

/**
 * Crash recovery. A process that died between the write and the settlement leaves an `executing`
 * record; this resolves it from the live catalog instead of repeating a non-idempotent write.
 */
export async function reconcileMutation(
  installation: InstallationIdentity,
  operationId: string,
  dependencies: Pick<MutationExecutionDependencies, "operationStore" | "readProduct" | "now">,
): Promise<ReconciliationResult> {
  const record = await dependencies.operationStore.get(installation, operationId);
  if (!record || record.status !== "executing") return { status: "not_applicable" };
  if (record.claimedAt === undefined || dependencies.now() - record.claimedAt < RECONCILE_MIN_AGE_MS) {
    return { status: "not_applicable" };
  }

  let product: IkasProduct | undefined;
  try {
    product = await dependencies.readProduct(record.payload.productId);
  } catch {
    return { status: "not_applicable" };
  }
  if (!product) return { status: "not_applicable" };

  // The pre-write snapshot is gone after a crash, so reconciliation compares the product with
  // itself: only the target value can decide the outcome, and no invariant claim is invented.
  const before = captureProductInvariants(product);
  const outcome = await verifyAgainstSourceOfTruth(record.payload, before, {
    readProduct: async () => product,
  });
  const settlement = settlementFor(outcome, dependencies.now());
  const settled = await dependencies.operationStore.settle(installation, operationId, settlement);
  return settled === "settled"
    ? { status: "settled", outcome: settlement.status }
    : { status: "not_applicable" };
}
