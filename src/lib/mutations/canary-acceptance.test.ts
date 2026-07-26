import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "@/globals/config";
import { HttpIkasProductAdapter } from "@/lib/ikas/product-adapter";
import { HttpIkasProductWriter } from "@/lib/ikas/product-writer";
import {
  captureProductInvariants,
  diffProductInvariants,
  type MutationTargetPath,
} from "@/lib/ikas/product-invariants";
import { IkasRequestLimiter } from "@/lib/ikas/request-limiter";
import type { IkasProduct } from "@/lib/ikas/types";

/**
 * The development-store canary.
 *
 * Everything else about the write path is proved against fixtures and a real Redis. This is the one
 * thing that cannot be: ikas does not document whether `updateProduct` carrying a single variant
 * leaves every other variant and every omitted field alone, and its variant input cannot even
 * express variant attributes or bundle settings. So the app never assumes it — it compares the
 * whole product before and after — and this run is what exercises that comparison against the real
 * API, on one field of one variant of one designated product, and puts it back.
 *
 * Triply gated so it can never run by accident: an explicit opt-in, an explicit target, and a
 * durable token for the store that target belongs to.
 *
 *   IKAS_CANARY=1 \
 *   IKAS_CANARY_STORE=dev-emre2 \
 *   IKAS_CANARY_PRODUCT_ID=... IKAS_CANARY_VARIANT_ID=... \
 *   IKAS_CANARY_BASE_SKU=... IKAS_CANARY_TEST_SKU=... \
 *   ./node_modules/.bin/vitest run src/lib/mutations/canary-acceptance.test.ts
 */

const enabled = process.env.IKAS_CANARY === "1";
const storeName = process.env.IKAS_CANARY_STORE ?? "";
const productId = process.env.IKAS_CANARY_PRODUCT_ID ?? "";
const variantId = process.env.IKAS_CANARY_VARIANT_ID ?? "";
const baseSku = process.env.IKAS_CANARY_BASE_SKU ?? "";
const testSku = process.env.IKAS_CANARY_TEST_SKU ?? "";

function tenantAccessToken(): string {
  const file = path.join(process.cwd(), ".ikas-runtime-tokens.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    { storeName?: string; accessToken?: string; expiresAt?: number }
  >;
  for (const record of Object.values(raw)) {
    if (record.storeName !== storeName) continue;
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) continue;
    if (record.accessToken) return record.accessToken;
  }
  throw new Error(`no live token for ${storeName}`);
}

function summarise(product: IkasProduct) {
  const variant = product.variants.find((candidate) => candidate.id === variantId);
  return {
    productName: product.name,
    variantCount: product.variants.length,
    sku: variant?.sku ?? null,
    prices: (variant?.prices ?? []).map((price) => ({
      sellPrice: price.sellPrice,
      buyPrice: price.buyPrice ?? null,
      discountPrice: price.discountPrice ?? null,
      currencyCode: price.currencyCode ?? null,
    })),
    stocks: (variant?.stocks ?? []).map((stock) => ({
      stockLocationId: stock.stockLocationId,
      stockCount: stock.stockCount,
      deleted: stock.deleted,
    })),
    barcodeList: variant?.barcodeList ?? [],
    imageCount: (variant?.images ?? []).length,
  };
}

describe.skipIf(!enabled)("development-store canary", () => {
  it(
    "changes one SKU, proves nothing else moved, and puts it back",
    async () => {
      expect(storeName && productId && variantId && baseSku && testSku, "target not fully specified").toBeTruthy();

      const accessToken = tenantAccessToken();
      const adapter = new HttpIkasProductAdapter(config.graphApiUrl, accessToken, 1);
      const writer = new HttpIkasProductWriter(
        config.graphApiUrl,
        accessToken,
        new IkasRequestLimiter(),
      );
      const target: MutationTargetPath = { kind: "sku_change", variantId };
      const report: Record<string, unknown> = {};

      // 1. Before snapshot.
      const before = await adapter.getProductById(productId);
      expect(before, "product not found").toBeDefined();
      report.before = summarise(before!);
      expect(before!.variants.find((v) => v.id === variantId)?.sku, "baseline SKU mismatch").toBe(baseSku);
      const beforeInvariants = captureProductInvariants(before!);

      // 2. Exactly one write.
      const [outcome] = await writer.writeVariantSkus({
        productId,
        variants: [{ variantId, sku: testSku }],
      });
      report.writeOutcome = outcome;

      // 3. Read back from the source of truth and compare the whole product.
      const afterWrite = await adapter.getProductById(productId);
      expect(afterWrite, "product disappeared after write").toBeDefined();
      report.afterWrite = summarise(afterWrite!);
      const changedByWrite = diffProductInvariants(
        beforeInvariants,
        captureProductInvariants(afterWrite!),
        target,
      );
      report.changedByWrite = changedByWrite;
      report.verdict = changedByWrite.length === 0 ? "INVARIANTS HELD" : "INVARIANT VIOLATION";

      // A violation stops here on purpose: another write cannot restore a field that was lost, and
      // it could make things worse. The operator gets the evidence and decides.
      if (changedByWrite.length > 0) {
        console.log("CANARY REPORT\n" + JSON.stringify(report, null, 2));
        throw new Error(`invariant violation: ${changedByWrite.join(", ")}`);
      }
      expect(afterWrite!.variants.find((v) => v.id === variantId)?.sku).toBe(testSku);

      // 4. Roll back.
      const [rollbackOutcome] = await writer.writeVariantSkus({
        productId,
        variants: [{ variantId, sku: baseSku }],
      });
      report.rollbackOutcome = rollbackOutcome;

      // 5. Prove the product is byte-for-byte where it started.
      const afterRollback = await adapter.getProductById(productId);
      expect(afterRollback, "product disappeared after rollback").toBeDefined();
      report.afterRollback = summarise(afterRollback!);
      const changedOverall = diffProductInvariants(
        beforeInvariants,
        captureProductInvariants(afterRollback!),
        target,
      );
      report.changedOverall = changedOverall;
      report.finalSku = afterRollback!.variants.find((v) => v.id === variantId)?.sku ?? null;

      console.log("CANARY REPORT\n" + JSON.stringify(report, null, 2));

      expect(changedOverall, "fields differ after rollback").toEqual([]);
      expect(report.finalSku).toBe(baseSku);
    },
    120_000,
  );
});
