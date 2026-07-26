import { describe, expect, it } from "vitest";
import { buildPricePayload, buildSkuPayload, buildStockPayload } from "./mutation-fixtures";
import {
  describeOperationTarget,
  hasControlCharacter,
  parseMutationOperationPayload,
  parseMutationSettlement,
  parsePriceLiteral,
} from "./mutation-operation";

describe("parseMutationOperationPayload", () => {
  it("accepts each supported operation kind", () => {
    expect(parseMutationOperationPayload(buildSkuPayload())).toBeDefined();
    expect(parseMutationOperationPayload(buildPricePayload())).toBeDefined();
    expect(parseMutationOperationPayload(buildStockPayload())).toBeDefined();
  });

  it("refuses an unknown kind rather than treating it as a weaker known one", () => {
    expect(parseMutationOperationPayload({ ...buildSkuPayload(), kind: "delete_product" })).toBeUndefined();
  });

  it("refuses an expiry that is not after creation", () => {
    expect(
      parseMutationOperationPayload(buildSkuPayload({ createdAt: 2_000, expiresAt: 2_000 })),
    ).toBeUndefined();
  });

  it("refuses a fractional or negative stock count", () => {
    expect(parseMutationOperationPayload(buildStockPayload({ proposedStockCount: 1.5 }))).toBeUndefined();
    expect(parseMutationOperationPayload(buildStockPayload({ expectedStockCount: -1 }))).toBeUndefined();
  });

  it("refuses an identifier outside the narrow allowed shape", () => {
    expect(parseMutationOperationPayload(buildSkuPayload({ productId: "a b" }))).toBeUndefined();
    expect(parseMutationOperationPayload(buildSkuPayload({ variantId: "" }))).toBeUndefined();
  });

  it("refuses a SKU carrying a control character or surrounding whitespace", () => {
    expect(parseMutationOperationPayload(buildSkuPayload({ proposedSku: " x" }))).toBeUndefined();
    expect(
      parseMutationOperationPayload(buildSkuPayload({ proposedSku: `A${String.fromCharCode(9)}B` })),
    ).toBeUndefined();
  });

  it("allows an absent previous SKU but never an absent proposed one", () => {
    expect(parseMutationOperationPayload(buildSkuPayload({ expectedPreviousSku: null }))).toBeDefined();
    expect(
      parseMutationOperationPayload({ ...buildSkuPayload(), proposedSku: null }),
    ).toBeUndefined();
  });
});

describe("parseMutationSettlement", () => {
  it("accepts each terminal shape and refuses an unlisted reason", () => {
    expect(
      parseMutationSettlement({ status: "succeeded", completedAt: 1, verifiedValue: 10 }),
    ).toBeDefined();
    expect(
      parseMutationSettlement({ status: "rejected", completedAt: 1, reason: "stale_value" }),
    ).toBeDefined();
    expect(
      parseMutationSettlement({ status: "rejected", completedAt: 1, reason: "because" }),
    ).toBeUndefined();
    expect(parseMutationSettlement({ status: "executing", completedAt: 1 })).toBeUndefined();
  });
});

describe("parsePriceLiteral", () => {
  it("accepts a plain decimal and rejects anything needing an assumption", () => {
    expect(parsePriceLiteral("0")).toBe(0);
    expect(parsePriceLiteral("149.90")).toBe(149.9);
    expect(parsePriceLiteral("1234.5678")).toBe(1234.5678);

    for (const invalid of ["", " 1", "1 ", "01", "1,5", "1e2", "-1", ".5", "1.", "1.23456", "abc"]) {
      expect(parsePriceLiteral(invalid)).toBeUndefined();
    }
    expect(parsePriceLiteral(149.9)).toBeUndefined();
  });
});

describe("hasControlCharacter", () => {
  it("detects the whole C0 range and DEL", () => {
    expect(hasControlCharacter("plain")).toBe(false);
    expect(hasControlCharacter(`a${String.fromCharCode(0)}b`)).toBe(true);
    expect(hasControlCharacter(`a${String.fromCharCode(0x1f)}b`)).toBe(true);
    expect(hasControlCharacter(`a${String.fromCharCode(0x7f)}b`)).toBe(true);
  });
});

describe("describeOperationTarget", () => {
  it("names one field per operation", () => {
    expect(describeOperationTarget(buildSkuPayload())).toBe("variant.sku");
    expect(describeOperationTarget(buildPricePayload())).toBe("variant.prices[default].sellPrice");
    expect(describeOperationTarget(buildStockPayload())).toBe(
      "variant.stocks[stockLocationId=location-1].stockCount",
    );
  });
});
