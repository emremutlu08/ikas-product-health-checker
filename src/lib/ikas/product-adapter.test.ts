import { describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError, IkasUpstreamError } from "./errors";
import { HttpIkasProductAdapter, PRODUCT_GRAPHQL_TIMEOUT_MS } from "./product-adapter";

const firstPage = {
  data: {
    listProduct: {
      data: [
        {
          id: "p1",
          name: "Product 1",
          type: "PHYSICAL",
          deleted: false,
          variants: [],
        },
      ],
      hasNext: true,
      page: 1,
      limit: 200,
    },
  },
};

const secondPage = {
  data: {
    listProduct: {
      data: [
        {
          id: "p2",
          name: "Product 2",
          type: "PHYSICAL",
          deleted: false,
          variants: [],
        },
      ],
      hasNext: false,
      page: 2,
      limit: 200,
    },
  },
};

describe("HttpIkasProductAdapter", () => {
  it("fetches every paginated listProduct page", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(firstPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondPage), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpIkasProductAdapter("https://example.test/graphql", "token").listProducts();

    expect(result.source).toBe("http");
    expect(result.products.map((product) => product.id)).toEqual(["p1", "p2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).variables.pagination).toEqual({ page: 1, limit: 200 });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).variables.pagination).toEqual({ page: 2, limit: 200 });

    vi.unstubAllGlobals();
  });

  it("throws a sanitized error for business GraphQL errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ message: "PROVIDER_DETAIL_SENTINEL" }] }), { status: 200 }),
      ),
    );

    const promise = new HttpIkasProductAdapter("https://example.test/graphql", "token").listProducts();
    await expect(promise).rejects.toBeInstanceOf(IkasUpstreamError);
    await expect(promise).rejects.not.toThrow("PROVIDER_DETAIL_SENTINEL");

    vi.unstubAllGlobals();
  });

  it("classifies only an exact authentication GraphQL code as an auth failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ errors: [{ message: "Login required", extensions: { code: "UNAUTHENTICATED" } }] }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      new HttpIkasProductAdapter("https://example.test/graphql", "token").listProducts(),
    ).rejects.toBeInstanceOf(IkasAuthenticationError);

    vi.unstubAllGlobals();
  });

  it("refuses to keep paginating past the configured page budget instead of returning partial data", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(firstPage), { status: 200 }));

    const promise = new HttpIkasProductAdapter(
      "https://example.test/graphql",
      "token",
      200,
      fetchMock,
      PRODUCT_GRAPHQL_TIMEOUT_MS,
      { maxPages: 2 },
    ).listProducts();

    await expect(promise).rejects.toBeInstanceOf(IkasUpstreamError);
    await expect(promise).rejects.toMatchObject({ code: "IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to return a catalog larger than the configured product budget", async () => {
    const oversizedPage = {
      data: {
        listProduct: {
          data: [
            { id: "p1", name: "Product 1", type: "PHYSICAL", deleted: false, variants: [] },
            { id: "p2", name: "Product 2", type: "PHYSICAL", deleted: false, variants: [] },
            { id: "p3", name: "Product 3", type: "PHYSICAL", deleted: false, variants: [] },
          ],
          hasNext: false,
          page: 1,
          limit: 200,
        },
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(oversizedPage), { status: 200 }));

    const promise = new HttpIkasProductAdapter(
      "https://example.test/graphql",
      "token",
      200,
      fetchMock,
      PRODUCT_GRAPHQL_TIMEOUT_MS,
      { maxProducts: 2 },
    ).listProducts();

    await expect(promise).rejects.toMatchObject({ code: "IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unusable scan budgets at construction time", () => {
    expect(
      () =>
        new HttpIkasProductAdapter("https://example.test/graphql", "token", 200, fetch, PRODUCT_GRAPHQL_TIMEOUT_MS, {
          maxPages: 0,
        }),
    ).toThrow(IkasUpstreamError);
    expect(
      () =>
        new HttpIkasProductAdapter("https://example.test/graphql", "token", 200, fetch, PRODUCT_GRAPHQL_TIMEOUT_MS, {
          maxProducts: -1,
        }),
    ).toThrow(IkasUpstreamError);
  });

  it("keeps the page limit bounded to the ikas maximum", () => {
    expect(() => new HttpIkasProductAdapter("https://example.test/graphql", "token", 201)).toThrow(IkasUpstreamError);
  });

  it("enforces one elapsed-time budget across the complete paginated scan", async () => {
    let now = 1_000;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      now = 1_101;
      return new Response(JSON.stringify(secondPage), { status: 200 });
    });

    const promise = new HttpIkasProductAdapter(
      "https://example.test/graphql",
      "token",
      200,
      fetchMock,
      PRODUCT_GRAPHQL_TIMEOUT_MS,
      { maxDurationMs: 100, now: () => now },
    ).listProducts();

    await expect(promise).rejects.toMatchObject({ code: "IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds a hung GraphQL request and returns only a sanitized upstream error", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const promise = new HttpIkasProductAdapter(
      "https://example.test/graphql",
      "ACCESS_TOKEN_SENTINEL",
      200,
      fetchMock,
      1,
    ).listProducts();

    await expect(promise).rejects.toMatchObject({ code: "IKAS_UPSTREAM_HTTP_ERROR" });
    await expect(promise).rejects.not.toThrow("ACCESS_TOKEN_SENTINEL");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
