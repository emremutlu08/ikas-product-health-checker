import { describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError } from "./errors";
import {
  applyItemErrors,
  HttpIkasProductWriter,
  ProductWriteError,
  SAVE_VARIANT_STOCKS_MUTATION,
  UPDATE_PRODUCT_MUTATION,
  UPDATE_VARIANT_PRICES_MUTATION,
} from "./product-writer";
import { IkasRequestLimiter } from "./request-limiter";

function limiter() {
  return new IkasRequestLimiter({ maxRequests: 50, windowMs: 10_000, maxConcurrent: 4, sleep: async () => {} });
}

type Recorded = { body: { query: string; variables: Record<string, unknown> } };

function writer(respond: (body: Recorded["body"]) => Response) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Recorded["body"];
    calls.push({ body });
    return respond(body);
  }) as unknown as typeof fetch;

  return {
    calls,
    writer: new HttpIkasProductWriter("https://api.example.com", "token", limiter(), fetchImpl),
  };
}

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("applyItemErrors", () => {
  it("marks only the reported indices as rejected", () => {
    expect(applyItemErrors(3, [{ errorCode: "INVALID", inputArrayIndex: 1 }])).toEqual([
      { status: "applied" },
      { status: "rejected", errorCode: "INVALID" },
      { status: "applied" },
    ]);
  });

  it("refuses to guess when an index cannot be placed", () => {
    expect(() => applyItemErrors(2, [{ errorCode: "X", inputArrayIndex: 5 }])).toThrow(
      ProductWriteError,
    );
    expect(() => applyItemErrors(2, [{ errorCode: "X", inputArrayIndex: 0.5 }])).toThrow(
      ProductWriteError,
    );
    expect(() => applyItemErrors(2, [{ inputArrayIndex: 0 }])).toThrow(ProductWriteError);
  });
});

describe("HttpIkasProductWriter", () => {
  it("sends only the product id and the one variant field for a SKU change", async () => {
    const { calls, writer: subject } = writer(() => ok({ updateProduct: { id: "product-1" } }));

    await subject.writeVariantSkus({
      productId: "product-1",
      variants: [{ variantId: "variant-1", sku: "NEW-SKU" }],
    });

    expect(calls[0]!.body.query).toBe(UPDATE_PRODUCT_MUTATION);
    expect(calls[0]!.body.variables).toEqual({
      input: { id: "product-1", variants: [{ id: "variant-1", sku: "NEW-SKU" }] },
    });
  });

  it("re-sends the whole price object so an override cannot drop a value", async () => {
    const { calls, writer: subject } = writer(() => ok({ updateVariantPrices: { errors: null } }));

    await subject.writeVariantPrices({
      priceListId: null,
      items: [
        {
          productId: "product-1",
          variantId: "variant-1",
          sellPrice: 149.9,
          buyPrice: 120,
          discountPrice: 249.9,
        },
      ],
    });

    expect(calls[0]!.body.query).toBe(UPDATE_VARIANT_PRICES_MUTATION);
    expect(calls[0]!.body.variables).toEqual({
      input: {
        variantPriceInputs: [
          {
            productId: "product-1",
            variantId: "variant-1",
            price: { sellPrice: 149.9, buyPrice: 120, discountPrice: 249.9 },
          },
        ],
      },
    });
  });

  it("omits a null price list rather than sending an explicit null", async () => {
    const { calls, writer: subject } = writer(() => ok({ updateVariantPrices: { errors: [] } }));

    await subject.writeVariantPrices({
      priceListId: null,
      items: [
        { productId: "p", variantId: "v", sellPrice: 10, buyPrice: null, discountPrice: null },
      ],
    });

    const input = calls[0]!.body.variables.input as Record<string, unknown>;
    expect("priceListId" in input).toBe(false);
    expect((input.variantPriceInputs as Array<{ price: unknown }>)[0]!.price).toEqual({ sellPrice: 10 });
  });

  it("sends an absolute stock count under the documented input wrapper", async () => {
    const { calls, writer: subject } = writer(() => ok({ saveVariantStocks: { errors: [] } }));

    await subject.writeVariantStocks([
      { productId: "p", variantId: "v", stockLocationId: "loc", stockCount: 25 },
    ]);

    expect(calls[0]!.body.query).toBe(SAVE_VARIANT_STOCKS_MUTATION);
    expect(calls[0]!.body.variables).toEqual({
      input: { stockInputs: [{ productId: "p", variantId: "v", stockLocationId: "loc", stockCount: 25 }] },
    });
  });

  it("maps an item error onto the exact submitted entry", async () => {
    const { writer: subject } = writer(() =>
      ok({ saveVariantStocks: { errors: [{ errorCode: "STOCK_LOCATION_NOT_FOUND", inputArrayIndex: 1 }] } }),
    );

    await expect(
      subject.writeVariantStocks([
        { productId: "p", variantId: "v1", stockLocationId: "loc", stockCount: 1 },
        { productId: "p", variantId: "v2", stockLocationId: "loc", stockCount: 2 },
      ]),
    ).resolves.toEqual([
      { status: "applied" },
      { status: "rejected", errorCode: "STOCK_LOCATION_NOT_FOUND" },
    ]);
  });

  it("never retries a write whose outcome is unknown", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const subject = new HttpIkasProductWriter(
      "https://api.example.com",
      "token",
      limiter(),
      attempt as unknown as typeof fetch,
    );

    await expect(
      subject.writeVariantSkus({ productId: "p", variants: [{ variantId: "v", sku: "S" }] }),
    ).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("pauses the shared limiter on 429 instead of retrying", async () => {
    const shared = limiter();
    const fetchImpl = (async () =>
      new Response("", { status: 429, headers: { "retry-after": "12" } })) as unknown as typeof fetch;
    const subject = new HttpIkasProductWriter("https://api.example.com", "token", shared, fetchImpl);

    await expect(
      subject.writeVariantStocks([
        { productId: "p", variantId: "v", stockLocationId: "loc", stockCount: 1 },
      ]),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(shared.pausedUntil).toBeGreaterThan(Date.now());
  });

  it("treats a mutation-level GraphQL error as unknown rather than as a rejection", async () => {
    const { writer: subject } = writer(
      () =>
        new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      subject.writeVariantSkus({ productId: "p", variants: [{ variantId: "v", sku: "S" }] }),
    ).rejects.toMatchObject({ code: "unknown_outcome" });
  });

  it("surfaces an authentication failure distinctly", async () => {
    const { writer: subject } = writer(() => new Response("", { status: 401 }));

    await expect(
      subject.writeVariantSkus({ productId: "p", variants: [{ variantId: "v", sku: "S" }] }),
    ).rejects.toBeInstanceOf(IkasAuthenticationError);
  });

  it("refuses a call larger than the per-call ceiling", async () => {
    const { writer: subject } = writer(() => ok({ saveVariantStocks: { errors: [] } }));

    await expect(
      subject.writeVariantStocks(
        Array.from({ length: 21 }, (_, index) => ({
          productId: "p",
          variantId: `v${index}`,
          stockLocationId: "loc",
          stockCount: 1,
        })),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
