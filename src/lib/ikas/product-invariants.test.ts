import { describe, expect, it } from "vitest";
import { buildProduct, buildVariant } from "@/lib/mutations/mutation-fixtures";
import { captureProductInvariants, diffProductInvariants, targetPath } from "./product-invariants";

const skuTarget = { kind: "sku_change", variantId: "variant-1" } as const;

describe("product invariants", () => {
  it("reports nothing when only the targeted field moved", () => {
    const before = captureProductInvariants(buildProduct());
    const after = captureProductInvariants(
      buildProduct({ variants: [buildVariant({ sku: "NEW-SKU" })] }),
    );

    expect(diffProductInvariants(before, after, skuTarget)).toEqual([]);
  });

  it("ignores the timestamps and totals ikas necessarily bumps", () => {
    const before = captureProductInvariants(buildProduct());
    const after = captureProductInvariants(
      buildProduct({
        updatedAt: 1_799_000_000_000,
        totalStock: 99,
        variants: [buildVariant({ sku: "NEW-SKU", updatedAt: 1_799_000_000_000 })],
      }),
    );

    expect(diffProductInvariants(before, after, skuTarget)).toEqual([]);
  });

  it("catches a sibling variant that changed during a single-variant update", () => {
    const before = captureProductInvariants(
      buildProduct({
        variants: [buildVariant(), buildVariant({ id: "variant-2", sku: "SIBLING" })],
      }),
    );
    const after = captureProductInvariants(
      buildProduct({
        variants: [
          buildVariant({ sku: "NEW-SKU" }),
          buildVariant({ id: "variant-2", sku: null }),
        ],
      }),
    );

    expect(diffProductInvariants(before, after, skuTarget)).toEqual(["variant[variant-2].sku"]);
  });

  it("catches an omitted variant field that the update silently dropped", () => {
    const before = captureProductInvariants(buildProduct());
    const after = captureProductInvariants(
      buildProduct({ variants: [buildVariant({ sku: "NEW-SKU", barcodeList: [] })] }),
    );

    expect(diffProductInvariants(before, after, skuTarget)).toEqual(["variant[variant-1].barcodeList"]);
  });

  it("catches a price object that lost its buy price when only the sell price was requested", () => {
    const priceTarget = { kind: "price_change", variantId: "variant-1", priceListId: null } as const;
    const before = captureProductInvariants(buildProduct());
    const after = captureProductInvariants(
      buildProduct({
        variants: [
          buildVariant({
            prices: [
              {
                sellPrice: 149.9,
                buyPrice: null,
                discountPrice: 249.9,
                currencyCode: "TRY",
                currencySymbol: "₺",
                priceListId: null,
              },
            ],
          }),
        ],
      }),
    );

    expect(diffProductInvariants(before, after, priceTarget)).toEqual([
      "variant[variant-1].price[default].buyPrice",
    ]);
  });

  it("allows the targeted stock location to move but not a sibling location", () => {
    const stockTarget = {
      kind: "stock_change",
      variantId: "variant-1",
      stockLocationId: "location-1",
    } as const;
    const stocks = (first: number, second: number) => [
      {
        id: "stock-1",
        productId: "product-1",
        variantId: "variant-1",
        stockLocationId: "location-1",
        stockCount: first,
        deleted: false,
      },
      {
        id: "stock-2",
        productId: "product-1",
        variantId: "variant-1",
        stockLocationId: "location-2",
        stockCount: second,
        deleted: false,
      },
    ];
    const before = captureProductInvariants(
      buildProduct({ variants: [buildVariant({ stocks: stocks(4, 7) })] }),
    );

    expect(
      diffProductInvariants(
        before,
        captureProductInvariants(
          buildProduct({ variants: [buildVariant({ stocks: stocks(25, 7) })] }),
        ),
        stockTarget,
      ),
    ).toEqual([]);
    expect(
      diffProductInvariants(
        before,
        captureProductInvariants(
          buildProduct({ variants: [buildVariant({ stocks: stocks(25, 0) })] }),
        ),
        stockTarget,
      ),
    ).toEqual(["variant[variant-1].stock[location-2].stockCount"]);
  });

  it("is stable when a list comes back in a different order", () => {
    const before = captureProductInvariants(buildProduct());
    const after = captureProductInvariants(
      buildProduct({
        tags: [{ id: "tag-1", name: "yeni" }],
        variants: [buildVariant({ barcodeList: ["869000000001"] })],
      }),
    );

    expect(diffProductInvariants(before, after, skuTarget)).toEqual([]);
  });

  it("treats a swapped product id as a total mismatch", () => {
    const before = captureProductInvariants(buildProduct());
    const after = captureProductInvariants(buildProduct({ id: "product-2" }));

    expect(diffProductInvariants(before, after, skuTarget)).toEqual(["product.id"]);
  });

  it("names the single path each operation kind may move", () => {
    expect(targetPath(skuTarget)).toBe("variant[variant-1].sku");
    expect(targetPath({ kind: "price_change", variantId: "v", priceListId: "list-9" })).toBe(
      "variant[v].price[list-9].sellPrice",
    );
    expect(targetPath({ kind: "stock_change", variantId: "v", stockLocationId: "loc" })).toBe(
      "variant[v].stock[loc].stockCount",
    );
  });
});
