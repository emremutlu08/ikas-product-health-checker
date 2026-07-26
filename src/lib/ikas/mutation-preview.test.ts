import { describe, expect, it } from "vitest";
import type { HealthReport } from "@/lib/ikas/types";
import { buildSkuChangePreview, MutationPreviewError } from "./mutation-preview";

function report(): HealthReport {
  return {
    generatedAt: "2026-07-26T08:00:00.000Z",
    score: 80,
    productCount: 1,
    variantCount: 1,
    issueCount: 1,
    affectedProductCount: 1,
    scanStatus: "success",
    issueCountsByCode: {
      missing_sku: 1,
      missing_barcode: 0,
      duplicate_sku: 0,
      duplicate_barcode: 0,
      missing_image: 0,
      missing_description: 0,
      missing_category: 0,
      missing_brand: 0,
      missing_vendor: 0,
      zero_stock_blocked: 0,
      low_stock: 0,
      missing_price: 0,
      duplicate_title: 0,
      weird_description: 0,
    },
    criticalCount: 1,
    warningCount: 0,
    infoCount: 0,
    outOfStockBlockedCount: 0,
    ruleSummaries: [],
    productRows: [],
    issues: [
      {
        code: "missing_sku",
        severity: "critical",
        productId: "product-1",
        productName: "Basic Shorts Black",
        variantId: "variant-1",
        variantLabel: "Black / M",
        message: "SKU eksik",
        productUpdatedAt: "2026-07-26T07:55:00.000Z",
      },
    ],
  };
}

describe("buildSkuChangePreview", () => {
  it("builds a preview only for the exact missing-SKU issue in the stored snapshot", () => {
    expect(
      buildSkuChangePreview(report(), {
        productId: "product-1",
        variantId: "variant-1",
        proposedSku: "BASIC-SHORTS-BLACK-M",
      }),
    ).toEqual({
      kind: "sku_change",
      mode: "preview_only",
      productId: "product-1",
      productName: "Basic Shorts Black",
      variantId: "variant-1",
      variantLabel: "Black / M",
      previousSku: null,
      proposedSku: "BASIC-SHORTS-BLACK-M",
      snapshotGeneratedAt: "2026-07-26T08:00:00.000Z",
      expectedProductUpdatedAt: "2026-07-26T07:55:00.000Z",
      requiresLiveVerification: true,
    });
  });

  it("refuses an invalid SKU instead of silently normalizing merchant input", () => {
    for (const proposedSku of ["", " SKU-1", "SKU-1 ", "SKU\u0000-1", "X".repeat(129)]) {
      expect(() =>
        buildSkuChangePreview(report(), {
          productId: "product-1",
          variantId: "variant-1",
          proposedSku,
        }),
      ).toThrowError(new MutationPreviewError("invalid_sku"));
    }
  });

  it("refuses a preview when the snapshot cannot provide a stale-write guard", () => {
    const staleGuardMissing = report();
    staleGuardMissing.issues[0]!.productUpdatedAt = undefined;

    expect(() =>
      buildSkuChangePreview(staleGuardMissing, {
        productId: "product-1",
        variantId: "variant-1",
        proposedSku: "SAFE-SKU",
      }),
    ).toThrowError(new MutationPreviewError("stale_guard_unavailable"));
  });

  it("refuses a product and variant pair that is not backed by the snapshot issue", () => {
    expect(() =>
      buildSkuChangePreview(report(), {
        productId: "product-1",
        variantId: "variant-attacker",
        proposedSku: "SAFE-SKU",
      }),
    ).toThrowError(new MutationPreviewError("issue_not_found"));
  });
});
