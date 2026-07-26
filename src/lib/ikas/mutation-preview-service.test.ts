import { describe, expect, it, vi } from "vitest";
import type { HealthReport } from "./types";
import {
  buildInstallationSkuChangePreview,
  prepareInstallationSkuChange,
  MutationPreviewServiceError,
} from "./mutation-preview-service";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "dev-store",
};

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
        message: "SKU eksik",
        productUpdatedAt: "2026-07-26T07:55:00.000Z",
      },
    ],
  };
}

describe("buildInstallationSkuChangePreview", () => {
  it("reads the exact installation snapshot and returns a non-mutating preview", async () => {
    const getLatestReport = vi.fn().mockResolvedValue({
      source: "snapshot",
      stale: false,
      snapshot: {
        version: 1,
        scanId: "scan-1",
        ...installation,
        generatedAt: "2026-07-26T08:00:00.000Z",
        report: report(),
      },
    });

    const preview = await buildInstallationSkuChangePreview(
      installation,
      { productId: "product-1", variantId: "variant-1", proposedSku: "SAFE-SKU" },
      { getLatestReport },
    );

    expect(getLatestReport).toHaveBeenCalledWith(installation);
    expect(preview).toMatchObject({
      mode: "preview_only",
      productId: "product-1",
      variantId: "variant-1",
      proposedSku: "SAFE-SKU",
      requiresLiveVerification: true,
    });
  });

  it("refuses a stale snapshot as a mutation eligibility baseline", async () => {
    await expect(
      buildInstallationSkuChangePreview(
        installation,
        { productId: "product-1", variantId: "variant-1", proposedSku: "SAFE-SKU" },
        {
          getLatestReport: vi.fn().mockResolvedValue({
            source: "snapshot",
            stale: true,
            snapshot: {
              version: 1,
              scanId: "scan-1",
              ...installation,
              generatedAt: "2026-07-25T08:00:00.000Z",
              report: report(),
            },
          }),
        },
      ),
    ).rejects.toEqual(new MutationPreviewServiceError("snapshot_stale"));
  });

  it("refuses to preview without a tenant-bound successful snapshot", async () => {
    await expect(
      buildInstallationSkuChangePreview(
        installation,
        { productId: "product-1", variantId: "variant-1", proposedSku: "SAFE-SKU" },
        { getLatestReport: vi.fn().mockResolvedValue({ source: "none" }) },
      ),
    ).rejects.toEqual(new MutationPreviewServiceError("snapshot_required"));
  });

  it("prepares a ten-minute one-time confirmation bound to the exact preview guard", async () => {
    const prepare = vi.fn().mockResolvedValue("prepared");
    const result = await prepareInstallationSkuChange(
      installation,
      { productId: "product-1", variantId: "variant-1", proposedSku: "SAFE-SKU" },
      {
        getLatestReport: vi.fn().mockResolvedValue({
          source: "snapshot",
          stale: false,
          snapshot: {
            version: 1,
            scanId: "scan-1",
            ...installation,
            generatedAt: "2026-07-26T08:00:00.000Z",
            report: report(),
          },
        }),
        operationStore: { prepare },
        createOperationId: () => "op-1",
        now: () => 1_785_000_000_000,
      },
    );

    expect(result).toMatchObject({
      operationId: "op-1",
      expiresAt: 1_785_000_600_000,
      preview: { proposedSku: "SAFE-SKU", requiresLiveVerification: true },
    });
    expect(prepare).toHaveBeenCalledWith(installation, {
      version: 1,
      operationId: "op-1",
      kind: "sku_change",
      status: "prepared",
      productId: "product-1",
      variantId: "variant-1",
      expectedProductUpdatedAt: "2026-07-26T07:55:00.000Z",
      expectedPreviousSku: null,
      proposedSku: "SAFE-SKU",
      createdAt: 1_785_000_000_000,
      expiresAt: 1_785_000_600_000,
    });
  });
});
