import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildProductIssueRows,
  PRODUCT_TABLE_PAGE_SIZE,
  selectProductTableRows,
  type ProductIssueRow,
  type ProductTableQuery,
} from "@/lib/dashboard/product-table";
import type { HealthIssue, ProductMistakeRow } from "@/lib/ikas/types";
import { ProductIssueTable } from "./ProductIssueTable";

function makeRows(count: number): ProductIssueRow[] {
  const productRows: ProductMistakeRow[] = Array.from({ length: count }, (_, index) => ({
    productId: `product-${index}`,
    productName: `Ürün ${index}`,
    imageLabel: "ÜR",
    updatedAt: "2026-07-17T08:00:00.000Z",
    mistakes: index % 2 === 0 ? ["SKU Eksik"] : ["Stokta Yok"],
    actionLabel: "İncele",
  }));
  const issues: HealthIssue[] = productRows.map((row, index) => ({
    code: index % 2 === 0 ? "missing_sku" : "zero_stock_blocked",
    severity: index === 0 ? "critical" : "warning",
    productId: row.productId,
    productName: row.productName,
    message: "test",
  }));
  return buildProductIssueRows({ productRows, issues });
}

const defaultQuery: ProductTableQuery = { rule: undefined, search: "", sort: "severity", page: 1 };

function render(
  options: {
    rows?: ProductIssueRow[];
    query?: ProductTableQuery;
    productCount?: number;
    totalAffectedProducts?: number;
    storeName?: string;
  } = {},
) {
  const rows = options.rows ?? makeRows(3);
  const query = options.query ?? defaultQuery;
  const productCount = options.productCount ?? 40;
  const totalAffectedProducts = options.totalAffectedProducts ?? rows.length;
  // Checked by key presence: a default parameter would substitute the store name back in
  // for an explicit `undefined`, and the no-store-name case would never actually be tested.
  const storeName = "storeName" in options ? options.storeName : "dev-emre2";

  return renderToStaticMarkup(
    <ProductIssueTable
      buildHref={(patch) =>
        `/?${new URLSearchParams(
          Object.entries(patch).filter(([, value]) => value !== undefined) as [string, string][],
        ).toString()}`
      }
      productCount={productCount}
      query={query}
      selection={selectProductTableRows(rows, query)}
      storeName={storeName}
      totalAffectedProducts={totalAffectedProducts}
    />,
  );
}

describe("the product name is the way into ikas admin", () => {
  it("links the product name to the ikas admin edit page", () => {
    const html = render();

    expect(html).toContain(
      '<a class="font-medium text-accent underline-offset-2 hover:underline" href="https://dev-emre2.myikas.com/admin/product/edit/product-0"',
    );
    expect(html).toContain("Ürün 0");
  });

  it("opens the admin link in a new tab safely", () => {
    const html = render();

    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("encodes the product id as one URL path segment", () => {
    const rows = makeRows(1).map((row) => ({
      ...row,
      productId: "../billing?returnUrl=https://evil.example",
    }));
    const html = render({ rows });

    expect(html).toContain(
      "https://dev-emre2.myikas.com/admin/product/edit/..%2Fbilling%3FreturnUrl%3Dhttps%3A%2F%2Fevil.example",
    );
    expect(html).not.toContain("/admin/product/billing");
    expect(html).not.toContain("?returnUrl=");
  });

  it("renders the name as plain text when no store name is known, never a dead link", () => {
    const html = render({ storeName: undefined });

    expect(html).not.toContain("myikas.com");
    expect(html).not.toContain('href="#');
    expect(html).toContain("Ürün 0");
  });

  it("drops the separate action column so the last column is never a clipped control", () => {
    const html = render();

    expect(html).not.toContain("İncele");
  });
});

describe("search", () => {
  it("submits search as a GET form so the term lands in the URL", () => {
    const html = render();

    expect(html).toContain('method="get"');
    expect(html).toContain('name="q"');
    expect(html).toContain("Ürün ara");
  });

  it("preserves the active rule and sort as hidden fields so searching does not reset them", () => {
    const html = render({ query: { ...defaultQuery, rule: "missing_sku", sort: "name" } });

    expect(html).toContain('name="rule"');
    expect(html).toContain('value="missing_sku"');
    expect(html).toContain('name="sort"');
    expect(html).toContain('value="name"');
  });

  it("reflects the current search term back into the input", () => {
    const html = render({ query: { ...defaultQuery, search: "kazak" } });

    expect(html).toContain('value="kazak"');
  });

  it("offers a clear-search action only while a search is active", () => {
    expect(render({ query: { ...defaultQuery, search: "kazak" } })).toContain("Aramayı temizle");
    expect(render()).not.toContain("Aramayı temizle");
  });
});

describe("sort", () => {
  it("offers every sort as a link and marks the active one for assistive technology", () => {
    const html = render({ query: { ...defaultQuery, sort: "name" } });

    expect(html).toContain("Öncelik");
    expect(html).toContain("Ürün adı");
    expect(html).toContain("Güncellenme");
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("marks the active sort with a textual cue, not only styling", () => {
    const html = render({ query: { ...defaultQuery, sort: "updated" } });

    expect(html).toContain("Sıralama: Güncellenme");
  });
});

describe("severity and active-filter summary", () => {
  it("summarises severity with words as well as colour", () => {
    const html = render();

    expect(html).toContain("Kritik");
    expect(html).toContain("Uyarı");
  });

  it("states which filter and search are narrowing the list", () => {
    const html = render({ query: { ...defaultQuery, rule: "missing_sku", search: "kazak" } });

    expect(html).toContain("SKU Eksik");
    expect(html).toContain("kazak");
  });

  it("says the list is unfiltered when nothing is narrowing it", () => {
    expect(render()).toContain("Tüm sorunlu ürünler gösteriliyor");
  });
});

describe("bounded rendering at large snapshot sizes", () => {
  const rows = makeRows(120);

  it("renders at most one page of rows regardless of snapshot size", () => {
    const html = render({ rows });

    expect(html.match(/<tr class="border-t border-border">/g)).toHaveLength(
      PRODUCT_TABLE_PAGE_SIZE,
    );
  });

  it("reports the rendered range and total", () => {
    const html = render({ rows });

    expect(html).toContain(`1–${PRODUCT_TABLE_PAGE_SIZE}`);
    expect(html).toContain("120");
  });

  it("offers a next page but no previous page on the first page", () => {
    const html = render({ rows });

    expect(html).toContain("Sonraki");
    expect(html).toContain('aria-disabled="true"');
  });

  it("offers a previous page in the middle of the list", () => {
    const html = render({ rows, query: { ...defaultQuery, page: 2 } });

    expect(html).toContain("Önceki");
    expect(html).toContain(`${PRODUCT_TABLE_PAGE_SIZE + 1}–${PRODUCT_TABLE_PAGE_SIZE * 2}`);
  });

  it("does not paginate a list that fits on one page", () => {
    const html = render();

    expect(html).not.toContain("Sonraki");
    expect(html).not.toContain("Önceki");
  });
});

describe("narrow embedded widths", () => {
  it("wraps the table in a keyboard-reachable scroll region with an explicit affordance", () => {
    const html = render();

    expect(html).toContain("overflow-x-auto");
    expect(html).not.toContain("overflow-hidden");
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("yatay kaydır");
  });

  it("keeps the scroll explanation visible through tablet widths", () => {
    const html = render();

    expect(html).toContain("lg:hidden");
    expect(html).not.toContain("md:hidden");
  });
});

describe("the four empty states are distinct", () => {
  const empty: ProductIssueRow[] = [];

  it("distinguishes a store with no products at all", () => {
    const html = render({ rows: empty, productCount: 0, totalAffectedProducts: 0 });

    expect(html).toContain("Mağazanızda taranacak ürün bulunamadı");
  });

  it("distinguishes a healthy store where no rule found anything", () => {
    const html = render({ rows: empty, productCount: 40, totalAffectedProducts: 0 });

    expect(html).toContain("Hiçbir kural sorun bulmadı");
  });

  it("distinguishes an active rule filter that matched nothing", () => {
    const html = render({
      rows: empty,
      totalAffectedProducts: 12,
      query: { ...defaultQuery, rule: "missing_sku" },
    });

    expect(html).toContain("Bu kurala uyan ürün yok");
  });

  it("distinguishes a search that matched nothing", () => {
    const html = render({
      rows: empty,
      totalAffectedProducts: 12,
      query: { ...defaultQuery, search: "kazak" },
    });

    expect(html).toContain("aramasıyla eşleşen ürün yok");
    expect(html).not.toContain("Bu kurala uyan ürün yok");
  });
});

describe("visual system", () => {
  it("uses semantic tokens rather than ad-hoc palette steps", () => {
    expect(render()).not.toMatch(/(slate|orange|violet|emerald|amber)-\d{2,3}/);
  });
});
