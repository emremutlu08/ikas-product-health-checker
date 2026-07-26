import { describe, expect, it } from "vitest";
import { buildProduct, buildVariant } from "@/lib/mutations/mutation-fixtures";
import { collectStockObservations } from "./stock-observation";

function stockRow(stockLocationId: string, stockCount: number, deleted = false) {
  return {
    id: `stock-${stockLocationId}`,
    productId: "product-1",
    variantId: "variant-1",
    stockLocationId,
    stockCount,
    deleted,
  };
}

describe("collectStockObservations", () => {
  it("projects one row per live stock location", () => {
    const product = buildProduct({
      variants: [buildVariant({ stocks: [stockRow("location-1", 4), stockRow("location-2", 0)] })],
    });

    expect(collectStockObservations([product])).toEqual({
      truncated: false,
      observations: [
        {
          productId: "product-1",
          productName: "Classic Laptop Sleeve",
          variantId: "variant-1",
          stockLocationId: "location-1",
          stockCount: 4,
        },
        {
          productId: "product-1",
          productName: "Classic Laptop Sleeve",
          variantId: "variant-1",
          stockLocationId: "location-2",
          stockCount: 0,
        },
      ],
    });
  });

  it("ignores deleted products, deleted or inactive variants, and deleted stock rows", () => {
    const products = [
      buildProduct({ id: "deleted-product", deleted: true }),
      buildProduct({ id: "inactive", variants: [buildVariant({ isActive: false })] }),
      buildProduct({ id: "removed-variant", variants: [buildVariant({ deleted: true })] }),
      buildProduct({
        id: "removed-stock",
        variants: [buildVariant({ stocks: [stockRow("location-1", 3, true)] })],
      }),
    ];

    expect(collectStockObservations(products).observations).toEqual([]);
  });

  it("labels variants only when a product actually has more than one", () => {
    const single = collectStockObservations([buildProduct()]).observations;
    const multiple = collectStockObservations([
      buildProduct({
        variants: [buildVariant(), buildVariant({ id: "variant-2", stocks: [stockRow("location-1", 1)] })],
      }),
    ]).observations;

    expect(single[0]!.variantLabel).toBeUndefined();
    expect(multiple.map((observation) => observation.variantLabel)).toEqual([
      "Varyant 1",
      "Varyant 2",
    ]);
  });

  it("reports truncation rather than silently sampling the catalog", () => {
    const products = Array.from({ length: 5 }, (_, index) =>
      buildProduct({ id: `product-${index}`, variants: [buildVariant({ id: `variant-${index}` })] }),
    );

    const result = collectStockObservations(products, 3);

    expect(result.truncated).toBe(true);
    expect(result.observations).toHaveLength(3);
  });

  it("shortens an unbounded product name", () => {
    const product = buildProduct({ name: "x".repeat(500) });

    expect(collectStockObservations([product]).observations[0]!.productName.length).toBeLessThanOrEqual(120);
  });
});
