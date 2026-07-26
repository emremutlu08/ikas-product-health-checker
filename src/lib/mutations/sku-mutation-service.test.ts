import { describe, expect, it, vi } from "vitest";
import { executeConfirmedSkuChange, SkuMutationExecutionError } from "./sku-mutation-service";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "dev-store",
};

const operation = {
  version: 1 as const,
  operationId: "op-1",
  kind: "sku_change" as const,
  status: "executing" as const,
  productId: "product-1",
  variantId: "variant-1",
  expectedProductUpdatedAt: "2026-07-26T07:55:00.000Z",
  expectedPreviousSku: null,
  proposedSku: "SAFE-SKU",
  createdAt: 1_785_000_000_000,
  expiresAt: 1_785_000_600_000,
  claimedAt: 1_785_000_001_000,
};

describe("executeConfirmedSkuChange", () => {
  it("rejects a stale live product without calling the writer and records a terminal audit", async () => {
    const writeSku = vi.fn();
    const settle = vi.fn().mockResolvedValue(true);

    await expect(
      executeConfirmedSkuChange(installation, "op-1", {
        writesEnabled: () => true,
        hasWriteFeature: vi.fn().mockResolvedValue(true),
        operationStore: {
          claim: vi.fn().mockResolvedValue({ outcome: "claimed", operation }),
          settle,
        },
        readProduct: vi.fn().mockResolvedValue({
          id: "product-1",
          name: "Product",
          updatedAt: "2026-07-26T07:56:00.000Z",
          type: "PHYSICAL",
          deleted: false,
          variants: [{ id: "variant-1", sku: null, deleted: false }],
        }),
        writeSku,
        now: () => 1_785_000_002_000,
      }),
    ).rejects.toEqual(new SkuMutationExecutionError("stale_product"));

    expect(writeSku).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(installation, "op-1", {
      status: "rejected",
      completedAt: 1_785_000_002_000,
      reason: "stale_product",
    });
  });

  it("rejects a changed live SKU without calling the writer", async () => {
    const writeSku = vi.fn();
    const settle = vi.fn().mockResolvedValue(true);

    await expect(
      executeConfirmedSkuChange(installation, "op-1", {
        writesEnabled: () => true,
        hasWriteFeature: vi.fn().mockResolvedValue(true),
        operationStore: {
          claim: vi.fn().mockResolvedValue({ outcome: "claimed", operation }),
          settle,
        },
        readProduct: vi.fn().mockResolvedValue({
          id: "product-1",
          name: "Product",
          updatedAt: operation.expectedProductUpdatedAt,
          type: "PHYSICAL",
          deleted: false,
          variants: [{ id: "variant-1", sku: "CHANGED", deleted: false }],
        }),
        writeSku,
        now: () => 1_785_000_002_000,
      }),
    ).rejects.toEqual(new SkuMutationExecutionError("stale_value"));

    expect(writeSku).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(installation, "op-1", {
      status: "rejected",
      completedAt: 1_785_000_002_000,
      reason: "stale_value",
    });
  });

  it("writes once, reads back the exact variant, and only then records success", async () => {
    const before = {
      id: "product-1",
      name: "Product",
      updatedAt: operation.expectedProductUpdatedAt,
      type: "PHYSICAL",
      deleted: false,
      variants: [{ id: "variant-1", sku: null, deleted: false }],
    };
    const after = {
      ...before,
      updatedAt: "2026-07-26T08:01:00.000Z",
      variants: [{ id: "variant-1", sku: "SAFE-SKU", deleted: false }],
    };
    const readProduct = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const writeSku = vi.fn().mockResolvedValue(undefined);
    const settle = vi.fn().mockResolvedValue(true);

    await expect(
      executeConfirmedSkuChange(installation, "op-1", {
        writesEnabled: () => true,
        hasWriteFeature: vi.fn().mockResolvedValue(true),
        operationStore: {
          claim: vi.fn().mockResolvedValue({ outcome: "claimed", operation }),
          settle,
        },
        readProduct,
        writeSku,
        now: () => 1_785_000_002_000,
      }),
    ).resolves.toEqual({ status: "succeeded", operationId: "op-1", verifiedSku: "SAFE-SKU" });

    expect(writeSku).toHaveBeenCalledTimes(1);
    expect(writeSku).toHaveBeenCalledWith({
      productId: "product-1",
      variantId: "variant-1",
      sku: "SAFE-SKU",
    });
    expect(readProduct).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledWith(installation, "op-1", {
      status: "succeeded",
      completedAt: 1_785_000_002_000,
      verifiedSku: "SAFE-SKU",
    });
  });

  it("never retries an uncertain writer failure and records reconciliation-required audit", async () => {
    const writeSku = vi.fn().mockRejectedValue(new Error("timeout"));
    const settle = vi.fn().mockResolvedValue(true);

    await expect(
      executeConfirmedSkuChange(installation, "op-1", {
        writesEnabled: () => true,
        hasWriteFeature: vi.fn().mockResolvedValue(true),
        operationStore: {
          claim: vi.fn().mockResolvedValue({ outcome: "claimed", operation }),
          settle,
        },
        readProduct: vi.fn().mockResolvedValue({
          id: "product-1",
          name: "Product",
          updatedAt: operation.expectedProductUpdatedAt,
          type: "PHYSICAL",
          deleted: false,
          variants: [{ id: "variant-1", sku: null, deleted: false }],
        }),
        writeSku,
        now: () => 1_785_000_002_000,
      }),
    ).rejects.toEqual(new SkuMutationExecutionError("mutation_outcome_unknown"));

    expect(writeSku).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(installation, "op-1", {
      status: "failed_unknown",
      completedAt: 1_785_000_002_000,
      reason: "mutation_outcome_unknown",
    });
  });

  it("records verification failure when read-back does not prove the intended SKU", async () => {
    const before = {
      id: "product-1",
      name: "Product",
      updatedAt: operation.expectedProductUpdatedAt,
      type: "PHYSICAL",
      deleted: false,
      variants: [{ id: "variant-1", sku: null, deleted: false }],
    };
    const settle = vi.fn().mockResolvedValue(true);

    await expect(
      executeConfirmedSkuChange(installation, "op-1", {
        writesEnabled: () => true,
        hasWriteFeature: vi.fn().mockResolvedValue(true),
        operationStore: {
          claim: vi.fn().mockResolvedValue({ outcome: "claimed", operation }),
          settle,
        },
        readProduct: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(before),
        writeSku: vi.fn().mockResolvedValue(undefined),
        now: () => 1_785_000_002_000,
      }),
    ).rejects.toEqual(new SkuMutationExecutionError("verification_failed"));

    expect(settle).toHaveBeenCalledWith(installation, "op-1", {
      status: "failed_unknown",
      completedAt: 1_785_000_002_000,
      reason: "verification_failed",
    });
  });
});
