import { readFileSync, writeFileSync } from "node:fs";
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
 * The bulk canary.
 *
 * The single-item canary proved that writing one variant leaves its siblings alone. Bulk carries a
 * risk that one cannot show: a batch sends several items in one call, and the response maps errors
 * back by array index, so a mis-alignment anywhere in that path would land one item's value on
 * another item's variant. Every item would look "written", the totals would agree, and the
 * merchant's catalog would be quietly wrong.
 *
 * So this does not merely check that the targeted variants changed. It gives each variant a value
 * only it should end up with, and fails if any variant holds a value meant for another.
 *
 * Stock is the field under test on purpose: it is the one correctable field that can be restored
 * exactly. A SKU cannot be written back to empty, so an SKU batch would leave permanent marks on
 * the store it is supposed to leave untouched.
 *
 *   IKAS_BULK_CANARY=1 \
 *   IKAS_CANARY_STORE=dev-emre2 \
 *   IKAS_CANARY_PRODUCT_ID=... \
 *   IKAS_BULK_CANARY_VARIANT_IDS=id1,id2,id3 \
 *   ./node_modules/.bin/vitest run src/lib/mutations/bulk-canary-acceptance.test.ts
 */

const enabled = process.env.IKAS_BULK_CANARY === "1";
const storeName = process.env.IKAS_CANARY_STORE ?? "";
const productId = process.env.IKAS_CANARY_PRODUCT_ID ?? "";
const variantIds = (process.env.IKAS_BULK_CANARY_VARIANT_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

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

/** The live stock row a correction would target: first undeleted row for the variant. */
function liveStock(product: IkasProduct, variantId: string) {
  const variant = product.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`variant ${variantId} not on product`);
  const stock = (variant.stocks ?? []).find((row) => !row.deleted);
  if (!stock) throw new Error(`variant ${variantId} has no live stock row`);
  return { stockLocationId: stock.stockLocationId, stockCount: stock.stockCount };
}

/**
 * A path that differs under *every* target is a path no target was allowed to touch: each call
 * excludes its own target, so a legitimately written field drops out of at least one diff.
 */
function unexpectedChanges(
  before: ReturnType<typeof captureProductInvariants>,
  after: ReturnType<typeof captureProductInvariants>,
  targets: MutationTargetPath[],
): string[] {
  const perTarget = targets.map((target) => new Set(diffProductInvariants(before, after, target)));
  const [first, ...rest] = perTarget;
  if (!first) return [];
  return [...first].filter((entry) => rest.every((other) => other.has(entry))).sort();
}

describe.skipIf(!enabled)("development-store bulk canary", () => {
  it(
    "writes several variants in one batch, proves each got its own value, and puts them all back",
    async () => {
      expect(storeName && productId, "target not fully specified").toBeTruthy();
      expect(variantIds.length, "bulk needs at least two variants to be meaningful").toBeGreaterThan(1);

      const accessToken = tenantAccessToken();
      const adapter = new HttpIkasProductAdapter(config.graphApiUrl, accessToken, 1);
      const writer = new HttpIkasProductWriter(
        config.graphApiUrl,
        accessToken,
        new IkasRequestLimiter(),
      );
      const report: Record<string, unknown> = {};

      const before = await adapter.getProductById(productId);
      expect(before, "product not found").toBeDefined();
      const beforeInvariants = captureProductInvariants(before!);

      // Each variant gets a distinct offset, so a value landing on the wrong variant is visible
      // rather than hidden behind "they all changed".
      const originals = variantIds.map((variantId, index) => {
        const stock = liveStock(before!, variantId);
        return {
          variantId,
          stockLocationId: stock.stockLocationId,
          original: stock.stockCount,
          proposed: stock.stockCount + 11 + index,
        };
      });
      report.plan = originals;

      const targets: MutationTargetPath[] = originals.map((item) => ({
        kind: "stock_change",
        variantId: item.variantId,
        stockLocationId: item.stockLocationId,
      }));

      // One call carrying every item, which is what bulk actually does per chunk.
      report.writeOutcomes = await writer.writeVariantStocks(
        originals.map((item) => ({
          productId,
          variantId: item.variantId,
          stockLocationId: item.stockLocationId,
          stockCount: item.proposed,
        })),
      );

      const afterWrite = await adapter.getProductById(productId);
      expect(afterWrite, "product disappeared after write").toBeDefined();

      const landed = originals.map((item) => ({
        variantId: item.variantId,
        expected: item.proposed,
        actual: liveStock(afterWrite!, item.variantId).stockCount,
      }));
      report.landed = landed;

      const changedByWrite = unexpectedChanges(
        beforeInvariants,
        captureProductInvariants(afterWrite!),
        targets,
      );
      report.changedByWrite = changedByWrite;

      // A violation stops here on purpose: a second write cannot restore a field that was lost,
      // and could make it worse. The operator gets the evidence and decides.
      if (changedByWrite.length > 0) {
        writeFileSync("/tmp/bulk-canary.json", JSON.stringify(report, null, 2));
        throw new Error(`invariant violation: ${changedByWrite.join(", ")}`);
      }

      // The cross-contamination check, stated per variant rather than in aggregate.
      for (const item of landed) {
        expect(item.actual, `variant ${item.variantId} holds another item's value`).toBe(
          item.expected,
        );
      }

      report.rollbackOutcomes = await writer.writeVariantStocks(
        originals.map((item) => ({
          productId,
          variantId: item.variantId,
          stockLocationId: item.stockLocationId,
          stockCount: item.original,
        })),
      );

      const afterRollback = await adapter.getProductById(productId);
      expect(afterRollback, "product disappeared after rollback").toBeDefined();

      const restored = originals.map((item) => ({
        variantId: item.variantId,
        expected: item.original,
        actual: liveStock(afterRollback!, item.variantId).stockCount,
      }));
      report.restored = restored;
      report.changedOverall = unexpectedChanges(
        beforeInvariants,
        captureProductInvariants(afterRollback!),
        targets,
      );

      writeFileSync("/tmp/bulk-canary.json", JSON.stringify(report, null, 2));

      expect(report.changedOverall, "fields differ after rollback").toEqual([]);
      for (const item of restored) {
        expect(item.actual, `variant ${item.variantId} was not restored`).toBe(item.expected);
      }
    },
    180_000,
  );
});
