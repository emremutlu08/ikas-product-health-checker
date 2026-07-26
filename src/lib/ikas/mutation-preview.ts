import type { HealthReport } from "./types";

export type MutationPreviewErrorCode =
  | "invalid_sku"
  | "issue_not_found"
  | "stale_guard_unavailable";

export const MAX_SKU_LENGTH = 128;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export class MutationPreviewError extends Error {
  readonly code: MutationPreviewErrorCode;

  constructor(code: MutationPreviewErrorCode) {
    super(code);
    this.name = "MutationPreviewError";
    this.code = code;
  }
}

export type SkuChangePreviewInput = {
  productId: string;
  variantId: string;
  proposedSku: string;
};

export type SkuChangePreview = {
  kind: "sku_change";
  mode: "preview_only";
  productId: string;
  productName: string;
  variantId: string;
  variantLabel?: string;
  previousSku: null;
  proposedSku: string;
  snapshotGeneratedAt: string;
  expectedProductUpdatedAt: string;
  requiresLiveVerification: true;
};

export function buildSkuChangePreview(
  report: Pick<HealthReport, "generatedAt" | "issues">,
  input: SkuChangePreviewInput,
): SkuChangePreview {
  if (
    input.proposedSku.length === 0 ||
    input.proposedSku.length > MAX_SKU_LENGTH ||
    input.proposedSku.trim() !== input.proposedSku ||
    CONTROL_CHARACTER.test(input.proposedSku)
  ) {
    throw new MutationPreviewError("invalid_sku");
  }

  const issue = report.issues.find(
    (candidate) =>
      candidate.code === "missing_sku" &&
      candidate.productId === input.productId &&
      candidate.variantId === input.variantId,
  );
  if (!issue) throw new MutationPreviewError("issue_not_found");
  if (!issue.productUpdatedAt || Number.isNaN(Date.parse(issue.productUpdatedAt))) {
    throw new MutationPreviewError("stale_guard_unavailable");
  }

  return {
    kind: "sku_change",
    mode: "preview_only",
    productId: issue.productId,
    productName: issue.productName,
    variantId: issue.variantId!,
    variantLabel: issue.variantLabel,
    previousSku: null,
    proposedSku: input.proposedSku,
    snapshotGeneratedAt: report.generatedAt,
    expectedProductUpdatedAt: issue.productUpdatedAt,
    requiresLiveVerification: true,
  };
}
