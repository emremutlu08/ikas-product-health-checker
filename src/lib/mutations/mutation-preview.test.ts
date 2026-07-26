import { describe, expect, it, vi } from "vitest";
import type { ProductHealthSnapshotResult } from "@/lib/ikas/report-service";
import type { HealthIssue, HealthReport, IkasProduct } from "@/lib/ikas/types";
import {
  buildProduct,
  buildVariant,
  PRODUCT_UPDATED_AT_ISO,
  TEST_TENANT,
} from "./mutation-fixtures";
import {
  buildCorrectionPreview,
  CorrectionPreviewError,
  MUTATION_CONFIRMATION_TTL_MS,
  prepareCorrection,
  type CorrectionRequest,
} from "./mutation-preview";
import { MemoryMutationOperationStore } from "./mutation-operation-store";

const NOW = 1_753_000_100_000;

function issue(overrides: Partial<HealthIssue> = {}): HealthIssue {
  return {
    code: "missing_sku",
    severity: "critical",
    productId: "product-1",
    productName: "Classic Laptop Sleeve",
    variantId: "variant-1",
    variantLabel: "Siyah",
    message: "Aktif varyantta SKU eksik.",
    productUpdatedAt: PRODUCT_UPDATED_AT_ISO,
    ...overrides,
  };
}

function snapshot(issues: HealthIssue[], stale = false): ProductHealthSnapshotResult {
  return {
    source: "snapshot",
    stale,
    snapshot: {
      generatedAt: "2026-07-26T10:00:00.000Z",
      report: { generatedAt: "2026-07-26T10:00:00.000Z", issues } as HealthReport,
    },
  } as unknown as ProductHealthSnapshotResult;
}

function dependencies({
  issues = [issue()],
  stale = false,
  product = buildProduct({ variants: [buildVariant({ sku: null })] }),
}: {
  issues?: HealthIssue[];
  stale?: boolean;
  /** `null` means ikas has no such product; omitted means the default fixture. */
  product?: IkasProduct | null;
} = {}) {
  return {
    getLatestReport: vi.fn(async () => snapshot(issues, stale)),
    readProduct: vi.fn(async () => product ?? undefined),
  };
}

const skuRequest: CorrectionRequest = {
  kind: "sku_change",
  productId: "product-1",
  variantId: "variant-1",
  proposedSku: "NEW-SKU",
};

describe("buildCorrectionPreview", () => {
  it("offers a correction only for an issue the latest scan actually found", async () => {
    const deps = dependencies({ issues: [issue({ code: "missing_barcode" })] });

    await expect(buildCorrectionPreview(TEST_TENANT, skuRequest, deps)).rejects.toMatchObject({
      code: "issue_not_found",
    });
    expect(deps.readProduct).not.toHaveBeenCalled();
  });

  it("refuses to plan from a missing or stale snapshot", async () => {
    await expect(
      buildCorrectionPreview(TEST_TENANT, skuRequest, {
        getLatestReport: async () => ({ source: "none" }) as ProductHealthSnapshotResult,
        readProduct: async () => buildProduct(),
      }),
    ).rejects.toMatchObject({ code: "snapshot_required" });

    await expect(
      buildCorrectionPreview(TEST_TENANT, skuRequest, dependencies({ stale: true })),
    ).rejects.toMatchObject({ code: "snapshot_stale" });
  });

  it("binds the stale guard to the live product rather than to the stored report", async () => {
    const { preview } = await buildCorrectionPreview(TEST_TENANT, skuRequest, dependencies());

    expect(preview.expectedProductUpdatedAt).toBe(PRODUCT_UPDATED_AT_ISO);
    expect(preview.mode).toBe("preview_only");
    expect(preview.requiresLiveVerification).toBe(true);
    expect(preview.previousValue).toBeNull();
    expect(preview.proposedValue).toBe("NEW-SKU");
    expect(preview.preservedFields).toContain("Diğer varyantlar");
  });

  it("rejects a proposal that would change nothing", async () => {
    const deps = dependencies({ product: buildProduct({ variants: [buildVariant({ sku: "NEW-SKU" })] }) });

    await expect(buildCorrectionPreview(TEST_TENANT, skuRequest, deps)).rejects.toMatchObject({
      code: "no_change",
    });
  });

  it("rejects a SKU that fails local safety validation", async () => {
    const deps = dependencies();

    await expect(
      buildCorrectionPreview(TEST_TENANT, { ...skuRequest, proposedSku: " padded" }, deps),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("plans a price change from the default price row and preserves the rest of the object", async () => {
    const deps = dependencies({ issues: [issue({ code: "missing_price" })] , product: buildProduct() });

    const { preview, plan } = await buildCorrectionPreview(
      TEST_TENANT,
      {
        kind: "price_change",
        productId: "product-1",
        variantId: "variant-1",
        proposedSellPrice: "149.90",
      },
      deps,
    );

    expect(preview.previousValue).toBe(199.9);
    expect(preview.proposedValue).toBe(149.9);
    expect(plan.intent).toEqual({
      kind: "price_change",
      priceListId: null,
      expectedSellPrice: 199.9,
      expectedBuyPrice: 120,
      expectedDiscountPrice: 249.9,
      proposedSellPrice: 149.9,
    });
  });

  it("refuses a price literal the app cannot represent exactly", async () => {
    const deps = dependencies({ issues: [issue({ code: "missing_price" })], product: buildProduct() });

    for (const proposedSellPrice of ["1.999.90", "12,5", "1e3", "-5", ".5", "1.234567"]) {
      await expect(
        buildCorrectionPreview(
          TEST_TENANT,
          { kind: "price_change", productId: "product-1", variantId: "variant-1", proposedSellPrice },
          deps,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("refuses a price change when the variant has no default price row", async () => {
    const deps = dependencies({
      issues: [issue({ code: "missing_price" })],
      product: buildProduct({
        variants: [buildVariant({ prices: [{ sellPrice: 10, priceListId: "list-1" }] })],
      }),
    });

    await expect(
      buildCorrectionPreview(
        TEST_TENANT,
        { kind: "price_change", productId: "product-1", variantId: "variant-1", proposedSellPrice: "5" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "price_row_missing" });
  });

  it("refuses a stock change when the variant has several locations and none was named", async () => {
    const deps = dependencies({
      issues: [issue({ code: "zero_stock_blocked" })],
      product: buildProduct({
        variants: [
          buildVariant({
            stocks: [
              { id: "s1", productId: "product-1", variantId: "variant-1", stockLocationId: "loc-1", stockCount: 0, deleted: false },
              { id: "s2", productId: "product-1", variantId: "variant-1", stockLocationId: "loc-2", stockCount: 0, deleted: false },
            ],
          }),
        ],
      }),
    });

    await expect(
      buildCorrectionPreview(
        TEST_TENANT,
        { kind: "stock_change", productId: "product-1", variantId: "variant-1", proposedStockCount: 5 },
        deps,
      ),
    ).rejects.toMatchObject({ code: "stock_location_ambiguous" });
  });

  it("binds a stock change to the exact named location", async () => {
    const deps = dependencies({ issues: [issue({ code: "low_stock" })], product: buildProduct() });

    const { preview } = await buildCorrectionPreview(
      TEST_TENANT,
      {
        kind: "stock_change",
        productId: "product-1",
        variantId: "variant-1",
        stockLocationId: "location-1",
        proposedStockCount: 25,
      },
      deps,
    );

    expect(preview.stockLocationId).toBe("location-1");
    expect(preview.previousValue).toBe(4);
    expect(preview.proposedValue).toBe(25);
  });

  it("rejects a non-integer or out-of-range stock count", async () => {
    const deps = dependencies({ issues: [issue({ code: "low_stock" })], product: buildProduct() });

    for (const proposedStockCount of [1.5, -1, 1_000_001, Number.NaN]) {
      await expect(
        buildCorrectionPreview(
          TEST_TENANT,
          { kind: "stock_change", productId: "product-1", variantId: "variant-1", proposedStockCount },
          deps,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("refuses when the live product or variant no longer exists", async () => {
    await expect(
      buildCorrectionPreview(TEST_TENANT, skuRequest, dependencies({ product: null })),
    ).rejects.toMatchObject({ code: "product_missing" });

    await expect(
      buildCorrectionPreview(
        TEST_TENANT,
        skuRequest,
        dependencies({ product: buildProduct({ variants: [buildVariant({ deleted: true })] }) }),
      ),
    ).rejects.toMatchObject({ code: "variant_missing" });
  });

  it("refuses when the live product carries no usable stale guard", async () => {
    await expect(
      buildCorrectionPreview(
        TEST_TENANT,
        skuRequest,
        dependencies({
          product: buildProduct({ updatedAt: null, variants: [buildVariant({ sku: null })] }),
        }),
      ),
    ).rejects.toMatchObject({ code: "stale_guard_unavailable" });
  });
});

describe("prepareCorrection", () => {
  it("returns an opaque operation id bound to a short one-time window", async () => {
    const operationStore = new MemoryMutationOperationStore();
    const created = await prepareCorrection(TEST_TENANT, skuRequest, {
      ...dependencies(),
      operationStore,
      createOperationId: () => "operation-1",
      now: () => NOW,
    });

    expect(created.operationId).toBe("operation-1");
    expect(created.expiresAt).toBe(NOW + MUTATION_CONFIRMATION_TTL_MS);

    const stored = await operationStore.get(TEST_TENANT, "operation-1");
    expect(stored).toMatchObject({
      status: "prepared",
      payload: {
        kind: "sku_change",
        origin: "single",
        expectedPreviousSku: null,
        proposedSku: "NEW-SKU",
        expectedProductUpdatedAt: PRODUCT_UPDATED_AT_ISO,
      },
    });
  });

  it("never stores a merchant-supplied tenant or product payload beyond the planned scalars", async () => {
    const operationStore = new MemoryMutationOperationStore();
    await prepareCorrection(TEST_TENANT, skuRequest, {
      ...dependencies(),
      operationStore,
      createOperationId: () => "operation-1",
      now: () => NOW,
    });

    const serialized = JSON.stringify(await operationStore.get(TEST_TENANT, "operation-1"));
    expect(serialized).not.toContain(TEST_TENANT.authorizedAppId);
    expect(serialized).not.toContain(TEST_TENANT.merchantId);
    expect(serialized).not.toContain("Classic Laptop Sleeve");
  });

  it("surfaces an operation id collision instead of overwriting a live confirmation", async () => {
    const operationStore = new MemoryMutationOperationStore();
    const deps = {
      ...dependencies(),
      operationStore,
      createOperationId: () => "operation-1",
      now: () => NOW,
    };
    await prepareCorrection(TEST_TENANT, skuRequest, deps);

    await expect(prepareCorrection(TEST_TENANT, skuRequest, deps)).rejects.toBeInstanceOf(
      CorrectionPreviewError,
    );
  });
});
