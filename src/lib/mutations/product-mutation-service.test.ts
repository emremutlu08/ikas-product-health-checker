import { describe, expect, it, vi } from "vitest";
import { ProductWriteError, type IkasProductWriter } from "@/lib/ikas/product-writer";
import type { IkasProduct } from "@/lib/ikas/types";
import {
  buildPricePayload,
  buildProduct,
  buildSkuPayload,
  buildStockPayload,
  buildVariant,
  TEST_TENANT,
} from "./mutation-fixtures";
import type { MutationOperationPayload } from "./mutation-operation";
import { MemoryMutationOperationStore } from "./mutation-operation-store";
import {
  executeConfirmedMutation,
  MutationExecutionError,
  reconcileMutation,
  RECONCILE_MIN_AGE_MS,
} from "./product-mutation-service";

const NOW = 1_753_000_200_000;

function stubWriter(overrides: Partial<IkasProductWriter> = {}) {
  return {
    writeVariantSkus: vi.fn(async () => [{ status: "applied" as const }]),
    writeVariantPrices: vi.fn(async () => [{ status: "applied" as const }]),
    writeVariantStocks: vi.fn(async () => [{ status: "applied" as const }]),
    ...overrides,
  } satisfies IkasProductWriter;
}

/**
 * A catalog that answers reads from a mutable list, so a test can describe exactly what ikas looks
 * like before and after the write instead of stubbing the verification decision itself.
 */
function catalog(states: Array<IkasProduct | undefined>) {
  let index = 0;
  return vi.fn(async () => {
    const product = states[Math.min(index, states.length - 1)];
    index += 1;
    return product;
  });
}

async function preparedStore(payload: MutationOperationPayload) {
  const operationStore = new MemoryMutationOperationStore();
  await operationStore.prepare(TEST_TENANT, payload);
  return operationStore;
}

async function run(
  payload: MutationOperationPayload,
  {
    products,
    writer = stubWriter(),
    writesEnabled = () => true,
    hasWriteFeature = async () => true,
    operationStore,
  }: {
    products: Array<IkasProduct | undefined>;
    writer?: IkasProductWriter;
    writesEnabled?: () => boolean;
    hasWriteFeature?: () => Promise<boolean>;
    operationStore?: MemoryMutationOperationStore;
  },
) {
  const store = operationStore ?? (await preparedStore(payload));
  const readProduct = catalog(products);
  const result = await executeConfirmedMutation(TEST_TENANT, payload.operationId, {
    writesEnabled,
    hasWriteFeature,
    operationStore: store,
    readProduct,
    writer,
    now: () => NOW,
  }).catch((error: unknown) => error);

  return { result, store, writer, readProduct };
}

const unchanged = buildProduct();
const skuApplied = buildProduct({ variants: [buildVariant({ sku: "NEW-SKU" })] });

describe("executeConfirmedMutation", () => {
  it("writes once, proves the value from the source of truth and settles a durable audit", async () => {
    const payload = buildSkuPayload();
    const { result, store, writer, readProduct } = await run(payload, {
      products: [unchanged, skuApplied],
    });

    expect(result).toEqual({
      status: "succeeded",
      operationId: payload.operationId,
      kind: "sku_change",
      verifiedValue: "NEW-SKU",
    });
    expect(writer.writeVariantSkus).toHaveBeenCalledTimes(1);
    // One preflight read and one read-back: success is never inferred from the mutation response.
    expect(readProduct).toHaveBeenCalledTimes(2);
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({
      status: "succeeded",
      settlement: { status: "succeeded", verifiedValue: "NEW-SKU" },
    });
  });

  it("keeps the write behind the kill switch", async () => {
    const payload = buildSkuPayload();
    const { result, writer } = await run(payload, {
      products: [unchanged],
      writesEnabled: () => false,
    });

    expect(result).toMatchObject({ code: "write_disabled" });
    expect(writer.writeVariantSkus).not.toHaveBeenCalled();
  });

  it("keeps the write behind the live write feature grant", async () => {
    const payload = buildSkuPayload();
    const { result, writer } = await run(payload, {
      products: [unchanged],
      hasWriteFeature: async () => false,
    });

    expect(result).toMatchObject({ code: "feature_required" });
    expect(writer.writeVariantSkus).not.toHaveBeenCalled();
  });

  it("rejects a replayed confirmation without touching the catalog again", async () => {
    const payload = buildSkuPayload();
    const store = await preparedStore(payload);
    await run(payload, { products: [unchanged, skuApplied], operationStore: store });

    const { result, writer } = await run(payload, {
      products: [unchanged, skuApplied],
      operationStore: store,
    });

    expect(result).toMatchObject({ code: "confirmation_replay" });
    expect(writer.writeVariantSkus).not.toHaveBeenCalled();
  });

  it("refuses an unknown confirmation", async () => {
    const payload = buildSkuPayload();
    const { result } = await run(payload, {
      products: [unchanged],
      operationStore: new MemoryMutationOperationStore(),
    });

    expect(result).toMatchObject({ code: "confirmation_missing" });
  });

  it("refuses a write when the product moved since the preview", async () => {
    const payload = buildSkuPayload();
    const { result, store, writer } = await run(payload, {
      products: [buildProduct({ updatedAt: 1_799_000_000_000 })],
    });

    expect(result).toMatchObject({ code: "stale_product" });
    expect(writer.writeVariantSkus).not.toHaveBeenCalled();
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({
      status: "rejected",
      settlement: { reason: "stale_product" },
    });
  });

  it("refuses a write when the field itself moved since the preview", async () => {
    const payload = buildSkuPayload();
    const { result, writer } = await run(payload, {
      products: [buildProduct({ variants: [buildVariant({ sku: "SOMEONE-ELSE" })] })],
    });

    expect(result).toMatchObject({ code: "stale_value" });
    expect(writer.writeVariantSkus).not.toHaveBeenCalled();
  });

  it("refuses a price write when the buy price moved, so an override cannot clobber it", async () => {
    const payload = buildPricePayload();
    const { result, writer } = await run(payload, {
      products: [
        buildProduct({
          variants: [
            buildVariant({
              prices: [
                {
                  sellPrice: 199.9,
                  buyPrice: 130,
                  discountPrice: 249.9,
                  currencyCode: "TRY",
                  currencySymbol: "₺",
                  priceListId: null,
                },
              ],
            }),
          ],
        }),
      ],
    });

    expect(result).toMatchObject({ code: "stale_value" });
    expect(writer.writeVariantPrices).not.toHaveBeenCalled();
  });

  it("rejects a deleted product and a deleted variant separately", async () => {
    const payload = buildSkuPayload();

    expect((await run(payload, { products: [buildProduct({ deleted: true })] })).result).toMatchObject({
      code: "product_missing",
    });
    expect(
      (
        await run(payload, {
          products: [buildProduct({ variants: [buildVariant({ deleted: true })] })],
        })
      ).result,
    ).toMatchObject({ code: "variant_missing" });
  });

  it("records a preflight outage as a clean no-op rather than leaving the confirmation open", async () => {
    const payload = buildSkuPayload();
    const store = await preparedStore(payload);
    const result = await executeConfirmedMutation(TEST_TENANT, payload.operationId, {
      writesEnabled: () => true,
      hasWriteFeature: async () => true,
      operationStore: store,
      readProduct: async () => {
        throw new Error("upstream down");
      },
      writer: stubWriter(),
      now: () => NOW,
    }).catch((error: unknown) => error);

    expect(result).toMatchObject({ code: "preflight_failed" });
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({
      status: "rejected",
      settlement: { reason: "preflight_failed" },
    });
  });

  it("reconciles an unknown outcome by reading, and reports success when the write did land", async () => {
    const payload = buildSkuPayload();
    const writer = stubWriter({
      writeVariantSkus: vi.fn(async () => {
        throw new ProductWriteError("unknown_outcome");
      }),
    });
    const { result, store } = await run(payload, { products: [unchanged, skuApplied], writer });

    expect(result).toMatchObject({ status: "succeeded", verifiedValue: "NEW-SKU" });
    expect(writer.writeVariantSkus).toHaveBeenCalledTimes(1);
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({ status: "succeeded" });
  });

  it("reconciles an unknown outcome to a terminal rejection when nothing changed", async () => {
    const payload = buildSkuPayload();
    const writer = stubWriter({
      writeVariantSkus: vi.fn(async () => {
        throw new ProductWriteError("unknown_outcome");
      }),
    });
    const { result, store } = await run(payload, { products: [unchanged, unchanged], writer });

    expect(result).toMatchObject({ code: "write_rejected" });
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({
      status: "rejected",
      settlement: { reason: "write_rejected" },
    });
  });

  it("reports a rate-limited write distinctly while still settling it as a no-op", async () => {
    const payload = buildStockPayload();
    const writer = stubWriter({
      writeVariantStocks: vi.fn(async () => {
        throw new ProductWriteError("rate_limited");
      }),
    });
    const { result, store } = await run(payload, { products: [unchanged, unchanged], writer });

    expect(result).toMatchObject({ code: "rate_limited" });
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({
      settlement: { reason: "write_rejected" },
    });
  });

  it("never sends anything when the circuit is open", async () => {
    const payload = buildSkuPayload();
    const writer = stubWriter({
      writeVariantSkus: vi.fn(async () => {
        throw new ProductWriteError("circuit_open");
      }),
    });
    const { result } = await run(payload, { products: [unchanged], writer });

    expect(result).toMatchObject({ code: "preflight_failed" });
  });

  it("refuses to call a write successful when another field of the product moved", async () => {
    const payload = buildSkuPayload();
    const collateralDamage = buildProduct({
      variants: [buildVariant({ sku: "NEW-SKU", barcodeList: [] })],
    });
    const { result, store } = await run(payload, { products: [unchanged, collateralDamage] });

    expect(result).toMatchObject({ code: "invariant_violation" });
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({
      status: "failed_unknown",
      settlement: { reason: "invariant_violation" },
    });
  });

  it("refuses to call a write successful when the read-back shows a third value", async () => {
    const payload = buildSkuPayload();
    const surprise = buildProduct({ variants: [buildVariant({ sku: "SOMETHING-ELSE" })] });
    const { result } = await run(payload, { products: [unchanged, surprise] });

    expect(result).toMatchObject({ code: "verification_failed" });
  });

  it("treats a provider item error whose value nonetheless landed as unverified", async () => {
    const payload = buildStockPayload();
    const writer = stubWriter({
      writeVariantStocks: vi.fn(async () => [
        { status: "rejected" as const, errorCode: "STOCK_ERROR" },
      ]),
    });
    const applied = buildProduct({
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
    const { result } = await run(payload, { products: [unchanged, applied], writer });

    expect(result).toMatchObject({ code: "verification_failed" });
  });

  it("settles a provider item error that really did not apply as terminal", async () => {
    const payload = buildStockPayload();
    const writer = stubWriter({
      writeVariantStocks: vi.fn(async () => [
        { status: "rejected" as const, errorCode: "STOCK_ERROR" },
      ]),
    });
    const { result, store } = await run(payload, { products: [unchanged, unchanged], writer });

    expect(result).toMatchObject({ code: "write_rejected" });
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({
      status: "rejected",
      settlement: { reason: "write_rejected" },
    });
  });

  it("applies a stock change as an absolute count at the exact location", async () => {
    const payload = buildStockPayload();
    const applied = buildProduct({
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
    const { result, writer } = await run(payload, { products: [unchanged, applied] });

    expect(result).toMatchObject({ status: "succeeded", verifiedValue: 25 });
    expect(writer.writeVariantStocks).toHaveBeenCalledWith([
      { productId: "product-1", variantId: "variant-1", stockLocationId: "location-1", stockCount: 25 },
    ]);
  });
});

describe("reconcileMutation", () => {
  async function executingOperation() {
    const payload = buildSkuPayload();
    const store = await preparedStore(payload);
    await store.claim(TEST_TENANT, payload.operationId, NOW);
    return { payload, store };
  }

  it("leaves a recently claimed operation alone", async () => {
    const { payload, store } = await executingOperation();

    await expect(
      reconcileMutation(TEST_TENANT, payload.operationId, {
        operationStore: store,
        readProduct: async () => skuApplied,
        now: () => NOW + 1_000,
      }),
    ).resolves.toEqual({ status: "not_applicable" });
  });

  it("settles an abandoned operation from the live catalog without writing again", async () => {
    const { payload, store } = await executingOperation();

    await expect(
      reconcileMutation(TEST_TENANT, payload.operationId, {
        operationStore: store,
        readProduct: async () => skuApplied,
        now: () => NOW + RECONCILE_MIN_AGE_MS,
      }),
    ).resolves.toEqual({ status: "settled", outcome: "succeeded" });
    expect(await store.get(TEST_TENANT, payload.operationId)).toMatchObject({ status: "succeeded" });
  });

  it("settles an abandoned operation as rejected when the value never changed", async () => {
    const { payload, store } = await executingOperation();

    await expect(
      reconcileMutation(TEST_TENANT, payload.operationId, {
        operationStore: store,
        readProduct: async () => unchanged,
        now: () => NOW + RECONCILE_MIN_AGE_MS,
      }),
    ).resolves.toEqual({ status: "settled", outcome: "rejected" });
  });

  it("does nothing for an operation that already reached a terminal state", async () => {
    const payload = buildSkuPayload();
    const store = await preparedStore(payload);

    await expect(
      reconcileMutation(TEST_TENANT, payload.operationId, {
        operationStore: store,
        readProduct: async () => skuApplied,
        now: () => NOW + RECONCILE_MIN_AGE_MS,
      }),
    ).resolves.toEqual({ status: "not_applicable" });
  });
});

describe("MutationExecutionError", () => {
  it("carries only an allowlisted code", () => {
    expect(new MutationExecutionError("stale_value")).toMatchObject({
      code: "stale_value",
      name: "MutationExecutionError",
    });
  });
});
