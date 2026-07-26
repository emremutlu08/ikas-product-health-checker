import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import type { IkasProduct } from "@/lib/ikas/types";
import type {
  MutationOperationStore,
  SkuOperationSettlement,
} from "./mutation-operation-store";

export type SkuMutationExecutionErrorCode =
  | "write_disabled"
  | "feature_required"
  | "confirmation_missing"
  | "confirmation_expired"
  | "confirmation_replay"
  | "product_missing"
  | "variant_missing"
  | "stale_product"
  | "stale_value"
  | "mutation_outcome_unknown"
  | "verification_failed";

export class SkuMutationExecutionError extends Error {
  constructor(readonly code: SkuMutationExecutionErrorCode) {
    super(code);
    this.name = "SkuMutationExecutionError";
  }
}

type SkuMutationExecutionDependencies = {
  writesEnabled(): boolean;
  hasWriteFeature(installation: InstallationIdentity): Promise<boolean>;
  operationStore: Pick<MutationOperationStore, "claim" | "settle">;
  readProduct(productId: string): Promise<IkasProduct | undefined>;
  writeSku(input: { productId: string; variantId: string; sku: string }): Promise<void>;
  now(): number;
};

async function reject(
  installation: InstallationIdentity,
  operationId: string,
  reason: Extract<SkuOperationSettlement, { status: "rejected" }>["reason"],
  dependencies: SkuMutationExecutionDependencies,
): Promise<never> {
  await dependencies.operationStore.settle(installation, operationId, {
    status: "rejected",
    completedAt: dependencies.now(),
    reason,
  });
  throw new SkuMutationExecutionError(reason);
}

export async function executeConfirmedSkuChange(
  installation: InstallationIdentity,
  operationId: string,
  dependencies: SkuMutationExecutionDependencies,
): Promise<{ status: "succeeded"; operationId: string; verifiedSku: string }> {
  if (!dependencies.writesEnabled()) throw new SkuMutationExecutionError("write_disabled");
  if (!(await dependencies.hasWriteFeature(installation))) {
    throw new SkuMutationExecutionError("feature_required");
  }

  const claim = await dependencies.operationStore.claim(
    installation,
    operationId,
    dependencies.now(),
  );
  if (claim.outcome !== "claimed") {
    const errorCode = {
      missing: "confirmation_missing",
      expired: "confirmation_expired",
      replay: "confirmation_replay",
    } as const;
    throw new SkuMutationExecutionError(errorCode[claim.outcome]);
  }

  const product = await dependencies.readProduct(claim.operation.productId);
  if (!product || product.deleted) {
    return reject(installation, operationId, "product_missing", dependencies);
  }
  if (product.updatedAt !== claim.operation.expectedProductUpdatedAt) {
    return reject(installation, operationId, "stale_product", dependencies);
  }
  const variant = product.variants.find(
    (candidate) => candidate.id === claim.operation.variantId && !candidate.deleted,
  );
  if (!variant) return reject(installation, operationId, "variant_missing", dependencies);
  if ((variant.sku ?? null) !== claim.operation.expectedPreviousSku) {
    return reject(installation, operationId, "stale_value", dependencies);
  }

  try {
    await dependencies.writeSku({
      productId: claim.operation.productId,
      variantId: claim.operation.variantId,
      sku: claim.operation.proposedSku,
    });
  } catch {
    try {
      await dependencies.operationStore.settle(installation, operationId, {
        status: "failed_unknown",
        completedAt: dependencies.now(),
        reason: "mutation_outcome_unknown",
      });
    } catch {
      // The claimed operation remains replay-blocking if the audit backend is unavailable.
    }
    throw new SkuMutationExecutionError("mutation_outcome_unknown");
  }
  const verifiedProduct = await dependencies.readProduct(claim.operation.productId);
  const verifiedVariant = verifiedProduct?.variants.find(
    (candidate) => candidate.id === claim.operation.variantId && !candidate.deleted,
  );
  if (
    !verifiedProduct ||
    verifiedProduct.deleted ||
    !verifiedVariant ||
    verifiedVariant.sku !== claim.operation.proposedSku
  ) {
    try {
      await dependencies.operationStore.settle(installation, operationId, {
        status: "failed_unknown",
        completedAt: dependencies.now(),
        reason: "verification_failed",
      });
    } catch {
      // The claimed operation remains replay-blocking if the audit backend is unavailable.
    }
    throw new SkuMutationExecutionError("verification_failed");
  }
  const settlement = {
    status: "succeeded" as const,
    completedAt: dependencies.now(),
    verifiedSku: verifiedVariant.sku,
  };
  const settled = await dependencies.operationStore.settle(
    installation,
    operationId,
    settlement,
  );
  if (!settled) throw new SkuMutationExecutionError("verification_failed");
  return {
    status: "succeeded" as const,
    operationId,
    verifiedSku: verifiedVariant.sku,
  };
}
