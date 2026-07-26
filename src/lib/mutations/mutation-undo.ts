import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import { canonicalIkasTimestamp } from "@/lib/ikas/timestamps";
import type { IkasProduct } from "@/lib/ikas/types";
import { MUTATION_CONFIRMATION_TTL_MS, type CorrectionPreview } from "./mutation-preview";
import type { MutationOperationPayload } from "./mutation-operation";
import type { MutationOperationStore } from "./mutation-operation-store";
import { observeTargetValue } from "./product-mutation-service";

/**
 * Undoing a correction.
 *
 * A rollback is an ordinary confirmed operation in the opposite direction, not a privileged path:
 * it is previewed, confirmed once, claimed atomically and read back like any other write. Its one
 * extra guard is the reason it exists — the live value must still be exactly what this app wrote.
 * If anyone else has touched the field since, the rollback is refused rather than overwriting
 * someone's newer decision.
 */

export type UndoPreparationErrorCode =
  | "operation_missing"
  | "operation_not_undoable"
  | "undo_not_available"
  | "undo_baseline_changed"
  | "product_missing"
  | "variant_missing"
  | "stale_guard_unavailable"
  | "operation_conflict";

export class UndoPreparationError extends Error {
  constructor(readonly code: UndoPreparationErrorCode) {
    super(code);
    this.name = "UndoPreparationError";
  }
}

export type UndoPreparationDependencies = {
  operationStore: Pick<MutationOperationStore, "get" | "prepare">;
  readProduct(productId: string): Promise<IkasProduct | undefined>;
  createOperationId(): string;
  now(): number;
};

function inverseIntent(payload: MutationOperationPayload, verifiedValue: string | number | null) {
  switch (payload.kind) {
    case "sku_change": {
      // ikas does not document clearing a SKU by sending an empty or null value, so a correction
      // that filled a blank SKU has no proven inverse and is not offered as undoable.
      if (payload.expectedPreviousSku === null) return undefined;
      if (typeof verifiedValue !== "string") return undefined;
      return {
        fieldLabel: "SKU",
        previousValue: verifiedValue as string | number | null,
        proposedValue: payload.expectedPreviousSku as string | number,
        preservedFields: ["Barkod", "Fiyat", "Stok", "Görseller", "Diğer varyantlar"],
        intent: {
          kind: "sku_change" as const,
          expectedPreviousSku: verifiedValue,
          proposedSku: payload.expectedPreviousSku,
        },
      };
    }
    case "price_change": {
      if (typeof verifiedValue !== "number") return undefined;
      return {
        fieldLabel: "Satış fiyatı",
        previousValue: verifiedValue as string | number | null,
        proposedValue: payload.expectedSellPrice as string | number,
        preservedFields: ["Alış fiyatı", "İndirimli fiyat", "Para birimi", "Diğer fiyat listeleri", "Stok"],
        intent: {
          kind: "price_change" as const,
          priceListId: payload.priceListId,
          expectedSellPrice: verifiedValue,
          expectedBuyPrice: payload.expectedBuyPrice,
          expectedDiscountPrice: payload.expectedDiscountPrice,
          proposedSellPrice: payload.expectedSellPrice,
        },
      };
    }
    case "stock_change": {
      if (typeof verifiedValue !== "number") return undefined;
      return {
        fieldLabel: "Stok adedi",
        previousValue: verifiedValue as string | number | null,
        proposedValue: payload.expectedStockCount as string | number,
        preservedFields: ["Diğer stok konumları", "Fiyat", "SKU", "Diğer varyantlar"],
        intent: {
          kind: "stock_change" as const,
          stockLocationId: payload.stockLocationId,
          expectedStockCount: verifiedValue,
          proposedStockCount: payload.expectedStockCount,
        },
      };
    }
  }
}

export async function prepareUndo(
  installation: InstallationIdentity,
  operationId: string,
  dependencies: UndoPreparationDependencies,
): Promise<{ operationId: string; expiresAt: number; preview: CorrectionPreview }> {
  const record = await dependencies.operationStore.get(installation, operationId);
  if (!record) throw new UndoPreparationError("operation_missing");
  if (
    record.status !== "succeeded" ||
    record.settlement?.status !== "succeeded" ||
    record.payload.origin === "undo"
  ) {
    throw new UndoPreparationError("operation_not_undoable");
  }

  const inverse = inverseIntent(record.payload, record.settlement.verifiedValue);
  if (!inverse) throw new UndoPreparationError("undo_not_available");

  const product = await dependencies.readProduct(record.payload.productId);
  if (!product || product.deleted) throw new UndoPreparationError("product_missing");
  const variant = product.variants.find(
    (candidate) => candidate.id === record.payload.variantId && !candidate.deleted,
  );
  if (!variant) throw new UndoPreparationError("variant_missing");

  const observed = observeTargetValue(variant, record.payload);
  if (!observed.found || observed.value !== record.settlement.verifiedValue) {
    throw new UndoPreparationError("undo_baseline_changed");
  }

  const expectedProductUpdatedAt = canonicalIkasTimestamp(product.updatedAt);
  if (!expectedProductUpdatedAt) throw new UndoPreparationError("stale_guard_unavailable");

  const createdAt = dependencies.now();
  const expiresAt = createdAt + MUTATION_CONFIRMATION_TTL_MS;
  const undoOperationId = dependencies.createOperationId();
  const payload = {
    version: 2,
    operationId: undoOperationId,
    origin: "undo",
    undoOfOperationId: operationId,
    productId: record.payload.productId,
    variantId: record.payload.variantId,
    expectedProductUpdatedAt,
    createdAt,
    expiresAt,
    ...inverse.intent,
  } as MutationOperationPayload;

  const result = await dependencies.operationStore.prepare(installation, payload);
  if (result !== "prepared") throw new UndoPreparationError("operation_conflict");

  return {
    operationId: undoOperationId,
    expiresAt,
    preview: {
      kind: record.payload.kind,
      mode: "preview_only",
      productId: product.id,
      productName: product.name,
      variantId: variant.id,
      fieldLabel: inverse.fieldLabel,
      previousValue: inverse.previousValue,
      proposedValue: inverse.proposedValue,
      preservedFields: inverse.preservedFields,
      ...(record.payload.kind === "stock_change"
        ? { stockLocationId: record.payload.stockLocationId }
        : {}),
      ...(record.payload.kind === "price_change" ? { priceListId: record.payload.priceListId } : {}),
      snapshotGeneratedAt: new Date(record.payload.createdAt).toISOString(),
      expectedProductUpdatedAt,
      requiresLiveVerification: true,
    },
  };
}
