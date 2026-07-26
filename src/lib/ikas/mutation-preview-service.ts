import type { InstallationIdentity } from "./installation-auth";
import type { MutationOperationStore } from "@/lib/mutations/mutation-operation-store";
import {
  getLatestProductHealthReport,
  type ProductHealthSnapshotResult,
} from "./report-service";
import {
  buildSkuChangePreview,
  type SkuChangePreview,
  type SkuChangePreviewInput,
} from "./mutation-preview";

export type MutationPreviewServiceErrorCode =
  | "snapshot_required"
  | "snapshot_stale"
  | "operation_conflict";

export class MutationPreviewServiceError extends Error {
  readonly code: MutationPreviewServiceErrorCode;

  constructor(code: MutationPreviewServiceErrorCode) {
    super(code);
    this.name = "MutationPreviewServiceError";
    this.code = code;
  }
}

type MutationPreviewServiceDependencies = {
  getLatestReport(
    installation: InstallationIdentity,
  ): Promise<ProductHealthSnapshotResult>;
};

const defaultDependencies: MutationPreviewServiceDependencies = {
  getLatestReport: getLatestProductHealthReport,
};

export async function buildInstallationSkuChangePreview(
  installation: InstallationIdentity,
  input: SkuChangePreviewInput,
  dependencies: MutationPreviewServiceDependencies = defaultDependencies,
): Promise<SkuChangePreview> {
  const result = await dependencies.getLatestReport(installation);
  if (result.source === "none") {
    throw new MutationPreviewServiceError("snapshot_required");
  }
  if (result.stale) {
    throw new MutationPreviewServiceError("snapshot_stale");
  }

  return buildSkuChangePreview(result.snapshot.report, input);
}

export const MUTATION_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

type MutationPreparationDependencies = MutationPreviewServiceDependencies & {
  operationStore: Pick<MutationOperationStore, "prepare">;
  createOperationId(): string;
  now(): number;
};

export async function prepareInstallationSkuChange(
  installation: InstallationIdentity,
  input: SkuChangePreviewInput,
  dependencies: MutationPreparationDependencies,
): Promise<{
  operationId: string;
  expiresAt: number;
  preview: SkuChangePreview;
}> {
  const preview = await buildInstallationSkuChangePreview(installation, input, {
    getLatestReport: dependencies.getLatestReport,
  });
  const createdAt = dependencies.now();
  const expiresAt = createdAt + MUTATION_CONFIRMATION_TTL_MS;
  const operationId = dependencies.createOperationId();
  const result = await dependencies.operationStore.prepare(installation, {
    version: 1,
    operationId,
    kind: "sku_change",
    status: "prepared",
    productId: preview.productId,
    variantId: preview.variantId,
    expectedProductUpdatedAt: preview.expectedProductUpdatedAt,
    expectedPreviousSku: preview.previousSku,
    proposedSku: preview.proposedSku,
    createdAt,
    expiresAt,
  });
  if (result !== "prepared") {
    throw new MutationPreviewServiceError("operation_conflict");
  }
  return { operationId, expiresAt, preview };
}
