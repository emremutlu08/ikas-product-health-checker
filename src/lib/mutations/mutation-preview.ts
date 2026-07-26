import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import { canonicalIkasTimestamp } from "@/lib/ikas/timestamps";
import type { ProductHealthSnapshotResult } from "@/lib/ikas/report-service";
import type {
  HealthIssue,
  HealthIssueCode,
  IkasProduct,
  IkasProductVariant,
} from "@/lib/ikas/types";
import {
  parsePriceLiteral,
  skuSchema,
  MAX_STOCK_COUNT,
  type MutationIntent,
  type MutationOperationKind,
  type MutationOperationPayload,
} from "./mutation-operation";
import type { MutationOperationStore } from "./mutation-operation-store";

/**
 * Planning a correction, and nothing else.
 *
 * This module reads. It never writes, and it is the boundary that keeps the app a health checker
 * rather than a general catalog editor: a correction is only offered for a product and variant the
 * latest scan actually flagged, for the exact issue that the requested change would fix.
 *
 * The before/after values come from a live read rather than from the stored snapshot, so the
 * durable stale guard is bound to what ikas holds right now. The snapshot still decides *whether*
 * a correction may be offered at all.
 */

export const MUTATION_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/** Which scan findings authorize which correction. Nothing outside this map is correctable. */
export const CORRECTABLE_ISSUE_CODES: Record<MutationOperationKind, readonly HealthIssueCode[]> = {
  sku_change: ["missing_sku", "duplicate_sku"],
  price_change: ["missing_price"],
  stock_change: ["zero_stock_blocked", "low_stock"],
};

export type CorrectionRequest =
  | { kind: "sku_change"; productId: string; variantId: string; proposedSku: string }
  | {
      kind: "price_change";
      productId: string;
      variantId: string;
      /** A plain decimal literal. The app never parses a merchant price with a locale rule. */
      proposedSellPrice: string;
    }
  | {
      kind: "stock_change";
      productId: string;
      variantId: string;
      stockLocationId?: string;
      proposedStockCount: number;
    };

export type CorrectionPreviewErrorCode =
  | "invalid_request"
  | "snapshot_required"
  | "snapshot_stale"
  | "issue_not_found"
  | "product_missing"
  | "variant_missing"
  | "price_row_missing"
  | "price_row_ambiguous"
  | "stock_location_missing"
  | "stock_location_ambiguous"
  | "stale_guard_unavailable"
  | "no_change"
  | "operation_conflict";

export class CorrectionPreviewError extends Error {
  constructor(readonly code: CorrectionPreviewErrorCode) {
    super(code);
    this.name = "CorrectionPreviewError";
  }
}

export type CorrectionPreview = {
  kind: MutationOperationKind;
  mode: "preview_only";
  productId: string;
  productName: string;
  variantId: string;
  variantLabel?: string;
  /** Absent for a rollback, which is authorized by a settled operation rather than by a finding. */
  issueCode?: HealthIssueCode;
  fieldLabel: string;
  previousValue: string | number | null;
  proposedValue: string | number;
  /** Named so the merchant sees exactly what is promised to stay untouched and is re-checked. */
  preservedFields: string[];
  stockLocationId?: string;
  priceListId?: string | null;
  snapshotGeneratedAt: string;
  expectedProductUpdatedAt: string;
  requiresLiveVerification: true;
};

export type CorrectionPreparation = {
  operationId: string;
  expiresAt: number;
  preview: CorrectionPreview;
};

export type CorrectionPreviewDependencies = {
  getLatestReport(installation: InstallationIdentity): Promise<ProductHealthSnapshotResult>;
  readProduct(productId: string): Promise<IkasProduct | undefined>;
};

export type CorrectionPreparationDependencies = CorrectionPreviewDependencies & {
  operationStore: Pick<MutationOperationStore, "prepare">;
  createOperationId(): string;
  now(): number;
};

function findIssue(
  issues: readonly HealthIssue[],
  request: CorrectionRequest,
): HealthIssue | undefined {
  const allowed = CORRECTABLE_ISSUE_CODES[request.kind];
  return issues.find(
    (issue) =>
      issue.productId === request.productId &&
      issue.variantId === request.variantId &&
      allowed.includes(issue.code),
  );
}

function activeVariant(product: IkasProduct, variantId: string): IkasProductVariant | undefined {
  return product.variants.find((candidate) => candidate.id === variantId && !candidate.deleted);
}

function variantLabelOf(issue: HealthIssue) {
  return issue.variantLabel ? { variantLabel: issue.variantLabel } : {};
}

type PlannedChange = {
  fieldLabel: string;
  previousValue: string | number | null;
  proposedValue: string | number;
  preservedFields: string[];
  intent: MutationIntent;
  stockLocationId?: string;
  priceListId?: string | null;
};

function planSkuChange(variant: IkasProductVariant, proposedSku: string): PlannedChange {
  if (!skuSchema.safeParse(proposedSku).success) {
    throw new CorrectionPreviewError("invalid_request");
  }
  const previousSku = variant.sku ?? null;
  if (previousSku !== null && !skuSchema.safeParse(previousSku).success) {
    // A SKU the app cannot round-trip safely is not a baseline it may promise to restore.
    throw new CorrectionPreviewError("stale_guard_unavailable");
  }
  if (previousSku === proposedSku) throw new CorrectionPreviewError("no_change");
  return {
    fieldLabel: "SKU",
    previousValue: previousSku,
    proposedValue: proposedSku,
    preservedFields: ["Barkod", "Fiyat", "Stok", "Görseller", "Diğer varyantlar"],
    intent: { kind: "sku_change", expectedPreviousSku: previousSku, proposedSku },
  };
}

/**
 * The default price row only. ikas does not document whether `updateVariantPrices` creates a
 * missing row, and a variant with several price lists has no unambiguous "the price", so both
 * cases fail closed instead of guessing which list a merchant meant.
 */
function planPriceChange(variant: IkasProductVariant, proposedLiteral: string): PlannedChange {
  const proposedSellPrice = parsePriceLiteral(proposedLiteral);
  if (proposedSellPrice === undefined) throw new CorrectionPreviewError("invalid_request");

  const rows = variant.prices ?? [];
  const defaultRows = rows.filter((price) => (price.priceListId ?? null) === null);
  if (defaultRows.length === 0) throw new CorrectionPreviewError("price_row_missing");
  if (defaultRows.length > 1) throw new CorrectionPreviewError("price_row_ambiguous");

  const row = defaultRows[0]!;
  if (typeof row.sellPrice !== "number" || !Number.isFinite(row.sellPrice) || row.sellPrice < 0) {
    throw new CorrectionPreviewError("price_row_missing");
  }
  if (row.sellPrice === proposedSellPrice) throw new CorrectionPreviewError("no_change");

  const buyPrice = typeof row.buyPrice === "number" ? row.buyPrice : null;
  const discountPrice = typeof row.discountPrice === "number" ? row.discountPrice : null;
  return {
    fieldLabel: "Satış fiyatı",
    previousValue: row.sellPrice,
    proposedValue: proposedSellPrice,
    preservedFields: ["Alış fiyatı", "İndirimli fiyat", "Para birimi", "Diğer fiyat listeleri", "Stok"],
    priceListId: null,
    intent: {
      kind: "price_change",
      priceListId: null,
      expectedSellPrice: row.sellPrice,
      expectedBuyPrice: buyPrice,
      expectedDiscountPrice: discountPrice,
      proposedSellPrice,
    },
  };
}

function planStockChange(
  variant: IkasProductVariant,
  request: Extract<CorrectionRequest, { kind: "stock_change" }>,
): PlannedChange {
  const { proposedStockCount } = request;
  if (
    !Number.isSafeInteger(proposedStockCount) ||
    proposedStockCount < 0 ||
    proposedStockCount > MAX_STOCK_COUNT
  ) {
    throw new CorrectionPreviewError("invalid_request");
  }

  const rows = (variant.stocks ?? []).filter((stock) => !stock.deleted);
  if (rows.length === 0) throw new CorrectionPreviewError("stock_location_missing");

  let row;
  if (request.stockLocationId) {
    row = rows.find((stock) => stock.stockLocationId === request.stockLocationId);
    if (!row) throw new CorrectionPreviewError("stock_location_missing");
  } else {
    if (rows.length > 1) throw new CorrectionPreviewError("stock_location_ambiguous");
    row = rows[0]!;
  }
  if (!Number.isSafeInteger(row.stockCount) || row.stockCount < 0) {
    throw new CorrectionPreviewError("stale_guard_unavailable");
  }
  if (row.stockCount === proposedStockCount) throw new CorrectionPreviewError("no_change");

  return {
    fieldLabel: "Stok adedi",
    previousValue: row.stockCount,
    proposedValue: proposedStockCount,
    preservedFields: ["Diğer stok konumları", "Fiyat", "SKU", "Diğer varyantlar"],
    stockLocationId: row.stockLocationId,
    intent: {
      kind: "stock_change",
      stockLocationId: row.stockLocationId,
      expectedStockCount: row.stockCount,
      proposedStockCount,
    },
  };
}

function planChange(variant: IkasProductVariant, request: CorrectionRequest): PlannedChange {
  switch (request.kind) {
    case "sku_change":
      return planSkuChange(variant, request.proposedSku);
    case "price_change":
      return planPriceChange(variant, request.proposedSellPrice);
    case "stock_change":
      return planStockChange(variant, request);
  }
}

export async function buildCorrectionPreview(
  installation: InstallationIdentity,
  request: CorrectionRequest,
  dependencies: CorrectionPreviewDependencies,
): Promise<{ preview: CorrectionPreview; plan: PlannedChange }> {
  const snapshot = await dependencies.getLatestReport(installation);
  if (snapshot.source === "none") throw new CorrectionPreviewError("snapshot_required");
  if (snapshot.stale) throw new CorrectionPreviewError("snapshot_stale");

  const issue = findIssue(snapshot.snapshot.report.issues, request);
  if (!issue) throw new CorrectionPreviewError("issue_not_found");

  const product = await dependencies.readProduct(request.productId);
  if (!product || product.deleted || product.id !== request.productId) {
    throw new CorrectionPreviewError("product_missing");
  }
  const variant = activeVariant(product, request.variantId);
  if (!variant) throw new CorrectionPreviewError("variant_missing");

  const expectedProductUpdatedAt = canonicalIkasTimestamp(product.updatedAt);
  if (!expectedProductUpdatedAt) throw new CorrectionPreviewError("stale_guard_unavailable");

  const plan = planChange(variant, request);

  return {
    plan,
    preview: {
      kind: request.kind,
      mode: "preview_only",
      productId: product.id,
      productName: product.name,
      variantId: variant.id,
      ...variantLabelOf(issue),
      issueCode: issue.code,
      fieldLabel: plan.fieldLabel,
      previousValue: plan.previousValue,
      proposedValue: plan.proposedValue,
      preservedFields: plan.preservedFields,
      ...(plan.stockLocationId ? { stockLocationId: plan.stockLocationId } : {}),
      ...(plan.priceListId !== undefined ? { priceListId: plan.priceListId } : {}),
      snapshotGeneratedAt: snapshot.snapshot.report.generatedAt,
      expectedProductUpdatedAt,
      requiresLiveVerification: true,
    },
  };
}

/**
 * Turns a preview into a one-time, tenant-bound, expiring confirmation. The client receives an
 * opaque operation id and nothing it could later replay with different values.
 */
export type CorrectionPreparationOptions = {
  /** A bulk item is the same operation with a batch tag, so the audit can group it. */
  origin?: "single" | "bulk";
  batchId?: string;
};

export async function prepareCorrection(
  installation: InstallationIdentity,
  request: CorrectionRequest,
  dependencies: CorrectionPreparationDependencies,
  { origin = "single", batchId }: CorrectionPreparationOptions = {},
): Promise<CorrectionPreparation> {
  const { preview, plan } = await buildCorrectionPreview(installation, request, dependencies);

  const createdAt = dependencies.now();
  const expiresAt = createdAt + MUTATION_CONFIRMATION_TTL_MS;
  const operationId = dependencies.createOperationId();
  const payload = {
    version: 2,
    operationId,
    origin,
    ...(batchId ? { batchId } : {}),
    productId: preview.productId,
    variantId: preview.variantId,
    expectedProductUpdatedAt: preview.expectedProductUpdatedAt,
    createdAt,
    expiresAt,
    ...plan.intent,
  } as MutationOperationPayload;

  const result = await dependencies.operationStore.prepare(installation, payload);
  if (result !== "prepared") throw new CorrectionPreviewError("operation_conflict");

  return { operationId, expiresAt, preview };
}
