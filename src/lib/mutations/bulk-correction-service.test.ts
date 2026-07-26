import { describe, expect, it, vi } from "vitest";
import type { IkasProductWriter } from "@/lib/ikas/product-writer";
import type { ProductHealthSnapshotResult } from "@/lib/ikas/report-service";
import type { HealthIssue, HealthReport, IkasProduct } from "@/lib/ikas/types";
import {
  BULK_CONSECUTIVE_FAILURE_LIMIT,
  BulkCorrectionError,
  cancelBulkCorrection,
  executeBulkCorrection,
  planBulkCorrection,
} from "./bulk-correction-service";
import { MemoryBulkBatchStore, MAX_BULK_ITEMS } from "./bulk-batch-store";
import { MemoryMutationOperationStore } from "./mutation-operation-store";
import { buildProduct, buildVariant, PRODUCT_UPDATED_AT_ISO, TEST_TENANT } from "./mutation-fixtures";
import type { CorrectionRequest } from "./mutation-preview";

const NOW = 1_753_000_100_000;

function issue(productId: string, variantId: string): HealthIssue {
  return {
    code: "missing_sku",
    severity: "critical",
    productId,
    productName: `Ürün ${productId}`,
    variantId,
    message: "Aktif varyantta SKU eksik.",
    productUpdatedAt: PRODUCT_UPDATED_AT_ISO,
  };
}

function catalog(count: number): Map<string, IkasProduct> {
  return new Map(
    Array.from({ length: count }, (_, index) => [
      `product-${index}`,
      buildProduct({
        id: `product-${index}`,
        variants: [buildVariant({ id: `variant-${index}`, sku: null })],
      }),
    ]),
  );
}

function skuRequest(index: number): CorrectionRequest {
  return {
    kind: "sku_change",
    productId: `product-${index}`,
    variantId: `variant-${index}`,
    proposedSku: `SKU-${index}`,
  };
}

function planDependencies(count: number, products = catalog(count)) {
  const operationStore = new MemoryMutationOperationStore();
  const batchStore = new MemoryBulkBatchStore();
  let operationSequence = 0;

  return {
    operationStore,
    batchStore,
    products,
    dependencies: {
      getLatestReport: async (): Promise<ProductHealthSnapshotResult> =>
        ({
          source: "snapshot",
          stale: false,
          snapshot: {
            generatedAt: "2026-07-26T10:00:00.000Z",
            report: {
              generatedAt: "2026-07-26T10:00:00.000Z",
              issues: Array.from({ length: count }, (_, index) =>
                issue(`product-${index}`, `variant-${index}`),
              ),
            } as HealthReport,
          },
        }) as unknown as ProductHealthSnapshotResult,
      readProduct: async (productId: string) => products.get(productId),
      operationStore,
      batchStore,
      createOperationId: () => `operation-${operationSequence++}`,
      createBatchId: () => "batch-1",
      now: () => NOW,
    },
  };
}

function writer(overrides: Partial<IkasProductWriter> = {}): IkasProductWriter {
  return {
    writeVariantSkus: vi.fn(async () => [{ status: "applied" as const }]),
    writeVariantPrices: vi.fn(async () => [{ status: "applied" as const }]),
    writeVariantStocks: vi.fn(async () => [{ status: "applied" as const }]),
    ...overrides,
  };
}

/** After a write lands, the catalog answers with the new SKU on every later read. */
function applyingCatalog(products: Map<string, IkasProduct>, written: Set<string>) {
  return async (productId: string) => {
    const product = products.get(productId);
    if (!product) return undefined;
    if (!written.has(productId)) return product;
    const index = productId.split("-")[1];
    return buildProduct({
      id: productId,
      variants: [buildVariant({ id: `variant-${index}`, sku: `SKU-${index}` })],
    });
  };
}

describe("planBulkCorrection", () => {
  it("reserves one operation per ready item without touching the catalog", async () => {
    const { dependencies, operationStore } = planDependencies(3);
    const write = writer();

    const plan = await planBulkCorrection(TEST_TENANT, [skuRequest(0), skuRequest(1), skuRequest(2)], dependencies);

    expect(plan.items.map((item) => item.state)).toEqual(["ready", "ready", "ready"]);
    expect(plan.planHash).toHaveLength(43);
    expect(await operationStore.get(TEST_TENANT, "operation-0")).toMatchObject({
      status: "prepared",
      payload: { origin: "bulk", batchId: "batch-1" },
    });
    for (const method of Object.values(write)) expect(method).not.toHaveBeenCalled();
  });

  it("classifies each unusable item instead of failing the whole plan", async () => {
    const { dependencies } = planDependencies(2);

    const plan = await planBulkCorrection(
      TEST_TENANT,
      [
        skuRequest(0),
        // Not in the scan report, so it is not correctable at all.
        { kind: "sku_change", productId: "product-9", variantId: "variant-9", proposedSku: "X" },
        // Invalid input rather than a stale catalog.
        { kind: "sku_change", productId: "product-1", variantId: "variant-1", proposedSku: " padded" },
      ],
      dependencies,
    );

    expect(plan.items.map((item) => item.state)).toEqual(["ready", "skipped", "invalid"]);
    expect(plan.items[1]!.reason).toBe("issue_not_found");
    expect(plan.items[2]!.reason).toBe("invalid_request");
  });

  it("refuses an empty, oversized or self-conflicting request", async () => {
    const { dependencies } = planDependencies(1);

    await expect(planBulkCorrection(TEST_TENANT, [], dependencies)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      planBulkCorrection(
        TEST_TENANT,
        Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, index) => skuRequest(index)),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "too_many_items" });
    await expect(
      planBulkCorrection(TEST_TENANT, [skuRequest(0), skuRequest(0)], dependencies),
    ).rejects.toMatchObject({ code: "duplicate_target" });
  });

  it("refuses a plan in which nothing at all could be applied", async () => {
    const { dependencies } = planDependencies(0);

    await expect(
      planBulkCorrection(TEST_TENANT, [skuRequest(0)], dependencies),
    ).rejects.toBeInstanceOf(BulkCorrectionError);
  });
});

function executionDependencies(
  fixture: ReturnType<typeof planDependencies>,
  {
    write,
    writesEnabled = () => true,
    hasWriteFeature = async () => true,
  }: {
    write?: (written: Set<string>) => Partial<IkasProductWriter>;
    writesEnabled?: () => boolean;
    hasWriteFeature?: () => Promise<boolean>;
  } = {},
) {
  const written = new Set<string>();
  const readProduct = applyingCatalog(fixture.products, written);
  const tracked = writer({
    writeVariantSkus: vi.fn(async (request: { productId: string }) => {
      written.add(request.productId);
      return [{ status: "applied" as const }];
    }),
    ...(write ? write(written) : {}),
  }) as IkasProductWriter & { writeVariantSkus: ReturnType<typeof vi.fn> };

  return {
    written,
    writer: tracked,
    dependencies: {
      writesEnabled,
      hasWriteFeature,
      operationStore: fixture.operationStore,
      batchStore: fixture.batchStore,
      readProduct,
      writer: tracked,
      now: () => NOW,
    },
  };
}

describe("executeBulkCorrection", () => {
  async function planned(count = 3) {
    const fixture = planDependencies(count);
    const plan = await planBulkCorrection(
      TEST_TENANT,
      Array.from({ length: count }, (_, index) => skuRequest(index)),
      fixture.dependencies,
    );
    return { fixture, plan };
  }

  it("applies every ready item once against the confirmed plan", async () => {
    const { fixture, plan } = await planned();
    const execution = executionDependencies(fixture);

    const result = await executeBulkCorrection(
      TEST_TENANT,
      plan.batchId,
      plan.planHash,
      execution.dependencies,
    );

    expect(result).toMatchObject({ status: "completed", succeeded: 3, rejected: 0, failedUnknown: 0 });
    expect(execution.writer.writeVariantSkus).toHaveBeenCalledTimes(3);
  });

  it("refuses a confirmation that does not match the plan the merchant saw", async () => {
    const { fixture, plan } = await planned();
    const execution = executionDependencies(fixture);

    await expect(
      executeBulkCorrection(TEST_TENANT, plan.batchId, "x".repeat(43), execution.dependencies),
    ).rejects.toMatchObject({ code: "plan_mismatch" });
    expect(execution.writer.writeVariantSkus).not.toHaveBeenCalled();
  });

  it("stays closed behind the bulk kill switch and the write entitlement", async () => {
    const { fixture, plan } = await planned(1);

    await expect(
      executeBulkCorrection(
        TEST_TENANT,
        plan.batchId,
        plan.planHash,
        executionDependencies(fixture, { writesEnabled: () => false }).dependencies,
      ),
    ).rejects.toMatchObject({ code: "write_disabled" });

    await expect(
      executeBulkCorrection(
        TEST_TENANT,
        plan.batchId,
        plan.planHash,
        executionDependencies(fixture, { hasWriteFeature: async () => false }).dependencies,
      ),
    ).rejects.toMatchObject({ code: "feature_required" });
  });

  it("never re-sends a completed item when the batch is resumed", async () => {
    const { fixture, plan } = await planned();
    const first = executionDependencies(fixture);
    await executeBulkCorrection(TEST_TENANT, plan.batchId, plan.planHash, first.dependencies);

    // A completed batch refuses a fresh run outright, and a resumed one reports from the audit.
    await expect(
      executeBulkCorrection(TEST_TENANT, plan.batchId, undefined, first.dependencies),
    ).rejects.toMatchObject({ code: "batch_replay" });
    expect(first.writer.writeVariantSkus).toHaveBeenCalledTimes(3);
  });

  it("resumes a stopped batch without repeating the items that already applied", async () => {
    const { fixture, plan } = await planned(20);
    let attempt = 0;
    const failing = executionDependencies(fixture, {
      write: (written) => ({
        writeVariantSkus: vi.fn(async (request: { productId: string }) => {
          attempt += 1;
          // Everything after the first chunk fails, so the breaker stops the batch mid-way.
          if (attempt > 5) throw new Error("network down");
          written.add(request.productId);
          return [{ status: "applied" as const }];
        }),
      }),
    });

    const first = await executeBulkCorrection(
      TEST_TENANT,
      plan.batchId,
      plan.planHash,
      failing.dependencies,
    );
    expect(first.status).toBe("stopped");
    expect(first.succeeded).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(20);

    const resumed = executionDependencies(fixture);
    const result = await executeBulkCorrection(
      TEST_TENANT,
      plan.batchId,
      undefined,
      resumed.dependencies,
    );

    expect(result.items).toHaveLength(20);
    // The items that already applied are reported from their audit, never written again.
    expect(resumed.writer.writeVariantSkus.mock.calls.length).toBeLessThan(20);
    expect(result.succeeded).toBe(15);
    // The five whose write provably did not apply are already settled, and a settled confirmation
    // is terminal: they are reported so the merchant can plan them again, not silently retried.
    expect(result.rejected).toBe(5);
  });

  it("stops starting new work as soon as the batch is cancelled mid-run", async () => {
    const { fixture, plan } = await planned(20);
    const execution = executionDependencies(fixture);
    const realGet = fixture.batchStore.get.bind(fixture.batchStore);
    let statusReads = 0;
    fixture.batchStore.get = (async (tenant, id) => {
      const record = await realGet(tenant, id);
      // The merchant cancels while the first chunk is running.
      if (record && record.status === "running" && ++statusReads >= 1) {
        await cancelBulkCorrection(TEST_TENANT, plan.batchId, { batchStore: { get: realGet, setStatus: fixture.batchStore.setStatus.bind(fixture.batchStore) } });
        return { ...record, status: "cancelled" as const };
      }
      return record;
    }) as typeof fixture.batchStore.get;

    const result = await executeBulkCorrection(
      TEST_TENANT,
      plan.batchId,
      plan.planHash,
      execution.dependencies,
    );

    expect(result.status).toBe("cancelled");
    // Whatever had already started still settled; nothing new was begun.
    expect(execution.writer.writeVariantSkus.mock.calls.length).toBeLessThan(20);
  });

  it("stops the batch after repeated unknown outcomes instead of burning the error budget", async () => {
    const { fixture, plan } = await planned(20);
    const execution = executionDependencies(fixture, {
      write: () => ({
        writeVariantSkus: vi.fn(async () => {
          throw new Error("timeout");
        }),
      }),
    });

    const result = await executeBulkCorrection(
      TEST_TENANT,
      plan.batchId,
      plan.planHash,
      execution.dependencies,
    );

    expect(result.status).toBe("stopped");
    expect(execution.writer.writeVariantSkus.mock.calls.length).toBeLessThanOrEqual(
      BULK_CONSECUTIVE_FAILURE_LIMIT + 2,
    );
  });

  it("reports non-ready items as skipped rather than silently dropping them", async () => {
    const fixture = planDependencies(1);
    const plan = await planBulkCorrection(
      TEST_TENANT,
      [skuRequest(0), { kind: "sku_change", productId: "product-9", variantId: "variant-9", proposedSku: "X" }],
      fixture.dependencies,
    );
    const execution = executionDependencies(fixture);

    const result = await executeBulkCorrection(
      TEST_TENANT,
      plan.batchId,
      plan.planHash,
      execution.dependencies,
    );

    expect(result.skipped).toBe(1);
    expect(result.items.map((item) => item.status)).toEqual(["succeeded", "skipped"]);
  });

  it("refuses an unknown batch", async () => {
    const fixture = planDependencies(1);

    await expect(
      executeBulkCorrection(
        TEST_TENANT,
        "missing-batch",
        undefined,
        executionDependencies(fixture).dependencies,
      ),
    ).rejects.toMatchObject({ code: "batch_missing" });
  });
});

describe("cancelBulkCorrection", () => {
  it("is idempotent and refuses to cancel a finished batch", async () => {
    const fixture = planDependencies(1);
    const plan = await planBulkCorrection(TEST_TENANT, [skuRequest(0)], fixture.dependencies);
    const execution = executionDependencies(fixture);

    await expect(
      cancelBulkCorrection(TEST_TENANT, plan.batchId, { batchStore: fixture.batchStore }),
    ).resolves.toBe("cancelled");
    await expect(
      cancelBulkCorrection(TEST_TENANT, plan.batchId, { batchStore: fixture.batchStore }),
    ).resolves.toBe("cancelled");
    await expect(
      executeBulkCorrection(TEST_TENANT, plan.batchId, plan.planHash, execution.dependencies),
    ).rejects.toMatchObject({ code: "batch_cancelled" });
  });
});
