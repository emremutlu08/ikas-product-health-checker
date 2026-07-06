import { describe, expect, it, vi } from "vitest";
import { HttpIkasProductAdapter } from "./product-adapter";

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

  it("throws a safe error for GraphQL errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "Nope" }] }), { status: 200 })),
    );

    await expect(new HttpIkasProductAdapter("https://example.test/graphql", "token").listProducts()).rejects.toThrow(
      "ikas GraphQL error: Nope",
    );

    vi.unstubAllGlobals();
  });
});
