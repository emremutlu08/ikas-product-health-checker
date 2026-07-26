import { describe, expect, it } from "vitest";
import { buildProduct, buildSkuPayload, buildStockPayload, buildVariant, TEST_TENANT } from "./mutation-fixtures";
import { MemoryMutationOperationStore } from "./mutation-operation-store";
import type { MutationOperationPayload, MutationSettlement } from "./mutation-operation";
import { prepareUndo, UndoPreparationError } from "./mutation-undo";

const NOW = 1_753_000_400_000;
const applied = buildProduct({ variants: [buildVariant({ sku: "NEW-SKU" })] });

async function settledStore(
  payload: MutationOperationPayload,
  settlement: MutationSettlement,
) {
  const store = new MemoryMutationOperationStore();
  await store.prepare(TEST_TENANT, payload);
  await store.claim(TEST_TENANT, payload.operationId, payload.createdAt + 1);
  await store.settle(TEST_TENANT, payload.operationId, settlement);
  return store;
}

function undoDependencies(store: MemoryMutationOperationStore, product = applied) {
  return {
    operationStore: store,
    readProduct: async () => product,
    createOperationId: () => "undo-1",
    now: () => NOW,
  };
}

describe("prepareUndo", () => {
  it("plans the inverse change and binds it to what this app actually wrote", async () => {
    const payload = buildSkuPayload();
    const store = await settledStore(payload, {
      status: "succeeded",
      completedAt: NOW - 1_000,
      verifiedValue: "NEW-SKU",
    });

    const undo = await prepareUndo(TEST_TENANT, payload.operationId, undoDependencies(store));

    expect(undo.operationId).toBe("undo-1");
    expect(undo.preview.previousValue).toBe("NEW-SKU");
    expect(undo.preview.proposedValue).toBe("OLD-SKU");
    expect(await store.get(TEST_TENANT, "undo-1")).toMatchObject({
      status: "prepared",
      payload: {
        origin: "undo",
        undoOfOperationId: payload.operationId,
        expectedPreviousSku: "NEW-SKU",
        proposedSku: "OLD-SKU",
      },
    });
  });

  it("refuses when another actor has changed the value since the correction", async () => {
    const payload = buildSkuPayload();
    const store = await settledStore(payload, {
      status: "succeeded",
      completedAt: NOW - 1_000,
      verifiedValue: "NEW-SKU",
    });

    await expect(
      prepareUndo(
        TEST_TENANT,
        payload.operationId,
        undoDependencies(store, buildProduct({ variants: [buildVariant({ sku: "THIRD-PARTY" })] })),
      ),
    ).rejects.toMatchObject({ code: "undo_baseline_changed" });
  });

  it("refuses to undo an operation that did not verifiably succeed", async () => {
    const payload = buildSkuPayload();
    const store = await settledStore(payload, {
      status: "failed_unknown",
      completedAt: NOW - 1_000,
      reason: "verification_failed",
    });

    await expect(
      prepareUndo(TEST_TENANT, payload.operationId, undoDependencies(store)),
    ).rejects.toMatchObject({ code: "operation_not_undoable" });
  });

  it("offers no undo when the original value was an empty SKU ikas cannot be asked to restore", async () => {
    const payload = buildSkuPayload({ expectedPreviousSku: null });
    const store = await settledStore(payload, {
      status: "succeeded",
      completedAt: NOW - 1_000,
      verifiedValue: "NEW-SKU",
    });

    await expect(
      prepareUndo(TEST_TENANT, payload.operationId, undoDependencies(store)),
    ).rejects.toMatchObject({ code: "undo_not_available" });
  });

  it("refuses to undo an undo", async () => {
    const payload = buildSkuPayload({ origin: "undo", undoOfOperationId: "operation-0" });
    const store = await settledStore(payload, {
      status: "succeeded",
      completedAt: NOW - 1_000,
      verifiedValue: "NEW-SKU",
    });

    await expect(
      prepareUndo(TEST_TENANT, payload.operationId, undoDependencies(store)),
    ).rejects.toBeInstanceOf(UndoPreparationError);
  });

  it("restores the exact previous absolute stock count at the same location", async () => {
    const payload = buildStockPayload();
    const store = await settledStore(payload, {
      status: "succeeded",
      completedAt: NOW - 1_000,
      verifiedValue: 25,
    });
    const afterWrite = buildProduct({
      totalStock: 25,
      variants: [
        buildVariant({
          stocks: [
            {
              id: "stock-1",
              productId: "product-1",
              variantId: "variant-1",
              stockLocationId: "location-1",
              stockCount: 25,
              deleted: false,
            },
          ],
        }),
      ],
    });

    const undo = await prepareUndo(
      TEST_TENANT,
      payload.operationId,
      undoDependencies(store, afterWrite),
    );

    expect(undo.preview.stockLocationId).toBe("location-1");
    expect(await store.get(TEST_TENANT, "undo-1")).toMatchObject({
      payload: { kind: "stock_change", expectedStockCount: 25, proposedStockCount: 4 },
    });
  });

  it("refuses when the operation belongs to no known confirmation", async () => {
    await expect(
      prepareUndo(TEST_TENANT, "missing", undoDependencies(new MemoryMutationOperationStore())),
    ).rejects.toMatchObject({ code: "operation_missing" });
  });
});
