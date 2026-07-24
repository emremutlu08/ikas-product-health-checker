import { describe, expect, it } from "vitest";
import type { HealthIssue, HealthReport, ProductMistakeRow } from "@/lib/ikas/types";
import {
  buildProductIssueRows,
  MAX_PRODUCT_TABLE_PAGE,
  parseProductTableQuery,
  PRODUCT_TABLE_PAGE_SIZE,
  selectProductTableRows,
  SEVERITY_LABELS,
} from "./product-table";

function row(overrides: Partial<ProductMistakeRow> & { productId: string }): ProductMistakeRow {
  return {
    productName: `Ürün ${overrides.productId}`,
    imageLabel: "ÜR",
    mistakes: ["SKU Eksik"],
    actionLabel: "İncele",
    ...overrides,
  };
}

function issue(overrides: Partial<HealthIssue> & { productId: string }): HealthIssue {
  return {
    code: "missing_sku",
    severity: "critical",
    productName: `Ürün ${overrides.productId}`,
    message: "test",
    ...overrides,
  };
}

function report(overrides: Partial<HealthReport>): HealthReport {
  return {
    generatedAt: "2026-07-20T08:00:00.000Z",
    score: 50,
    productCount: 10,
    variantCount: 10,
    issueCount: 0,
    affectedProductCount: 0,
    scanStatus: "success",
    issueCountsByCode: {
      missing_sku: 0,
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
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
    outOfStockBlockedCount: 0,
    ruleSummaries: [],
    productRows: [],
    issues: [],
    ...overrides,
  };
}

describe("parseProductTableQuery", () => {
  it("defaults to severity sort on the first page with no filter or search", () => {
    expect(parseProductTableQuery({})).toEqual({
      rule: undefined,
      search: "",
      sort: "severity",
      page: 1,
    });
  });

  it("reads a known rule, a search term, a known sort and a page from the URL", () => {
    expect(parseProductTableQuery({ rule: "out_of_stock", q: " kazak ", sort: "name", page: "3" })).toEqual(
      { rule: "out_of_stock", search: "kazak", sort: "name", page: 3 },
    );
  });

  it("rejects an unknown rule, an unknown sort and a non-numeric page instead of trusting them", () => {
    expect(parseProductTableQuery({ rule: "../etc/passwd", sort: "DROP TABLE", page: "abc" })).toEqual({
      rule: undefined,
      search: "",
      sort: "severity",
      page: 1,
    });
  });

  it("ignores repeated query parameters rather than concatenating them", () => {
    expect(parseProductTableQuery({ rule: ["missing_sku", "out_of_stock"], q: ["a", "b"] })).toEqual({
      rule: undefined,
      search: "",
      sort: "severity",
      page: 1,
    });
  });

  it("clamps a page below one and bounds an overlong search term", () => {
    expect(parseProductTableQuery({ page: "-4" }).page).toBe(1);
    expect(parseProductTableQuery({ q: "x".repeat(500) }).search).toHaveLength(100);
  });

  /**
   * Selection clamps to the real `pageCount`, so an enormous page was already harmless. Parsing
   * bounds it anyway, so every value that leaves this function is small enough to reason about
   * and to put in a URL, rather than a number that only stays safe because a later stage
   * happens to clamp it.
   */
  it("caps an absurd page at a documented constant instead of carrying it forward", () => {
    expect(parseProductTableQuery({ page: "999999999999" }).page).toBe(MAX_PRODUCT_TABLE_PAGE);
    expect(parseProductTableQuery({ page: String(Number.MAX_SAFE_INTEGER) }).page).toBe(
      MAX_PRODUCT_TABLE_PAGE,
    );
    expect(MAX_PRODUCT_TABLE_PAGE).toBeLessThanOrEqual(10_000);
  });

  it("still clamps the capped page down to the pages that actually exist", () => {
    const capped = parseProductTableQuery({ page: "999999999999" });

    expect(selectProductTableRows([], { ...capped }).page).toBe(1);
  });
});

describe("buildProductIssueRows", () => {
  it("attaches the highest severity among the issues that produced each row", () => {
    const rows = buildProductIssueRows(
      report({
        productRows: [row({ productId: "a" }), row({ productId: "b" })],
        issues: [
          issue({ productId: "a", severity: "warning", code: "missing_image" }),
          issue({ productId: "a", severity: "critical", code: "missing_sku" }),
          issue({ productId: "b", severity: "warning", code: "missing_image" }),
        ],
      }),
    );

    expect(rows.map((entry) => entry.severity)).toEqual(["critical", "warning"]);
  });

  it("ignores issues that do not roll up into a merchant-facing rule", () => {
    const rows = buildProductIssueRows(
      report({
        productRows: [row({ productId: "a" })],
        issues: [
          // missing_barcode is not mapped to a rule, so it must not raise the row severity.
          issue({ productId: "a", severity: "critical", code: "missing_barcode" }),
          issue({ productId: "a", severity: "info", code: "missing_image" }),
        ],
      }),
    );

    expect(rows[0]!.severity).toBe("info");
  });

  it("leaves severity null when a stored row has no matching issue rather than guessing", () => {
    const rows = buildProductIssueRows(report({ productRows: [row({ productId: "a" })], issues: [] }));

    expect(rows[0]!.severity).toBeNull();
  });

  it("labels every severity in Turkish so severity is never colour-only", () => {
    expect(SEVERITY_LABELS).toEqual({ critical: "Kritik", warning: "Uyarı", info: "Bilgi" });
  });
});

describe("selectProductTableRows", () => {
  const rows = buildProductIssueRows(
    report({
      productRows: [
        row({ productId: "p1", productName: "Zebra Kazak", mistakes: ["SKU Eksik"], updatedAt: "2026-07-01T00:00:00.000Z" }),
        row({ productId: "p2", productName: "Ankara Çanta", mistakes: ["Stokta Yok"], updatedAt: "2026-07-03T00:00:00.000Z" }),
        row({ productId: "p3", productName: "Çorap Seti", mistakes: ["Görsel Eksik"], updatedAt: "2026-07-02T00:00:00.000Z" }),
      ],
      issues: [
        issue({ productId: "p1", severity: "info", code: "missing_sku" }),
        issue({ productId: "p2", severity: "critical", code: "zero_stock_blocked" }),
        issue({ productId: "p3", severity: "warning", code: "missing_image" }),
      ],
    }),
  );

  const ids = (result: { rows: Array<{ productId: string }> }) =>
    result.rows.map((entry) => entry.productId);

  it("sorts by severity first by default", () => {
    expect(ids(selectProductTableRows(rows, { sort: "severity", page: 1, search: "" }))).toEqual([
      "p2",
      "p3",
      "p1",
    ]);
  });

  it("sorts by product name using Turkish collation", () => {
    expect(ids(selectProductTableRows(rows, { sort: "name", page: 1, search: "" }))).toEqual([
      "p2",
      "p3",
      "p1",
    ]);
  });

  it("sorts by most recently updated first", () => {
    expect(ids(selectProductTableRows(rows, { sort: "updated", page: 1, search: "" }))).toEqual([
      "p2",
      "p3",
      "p1",
    ]);
  });

  it("breaks ties deterministically by product id", () => {
    const tied = buildProductIssueRows(
      report({
        productRows: [
          row({ productId: "b", productName: "Aynı Ad" }),
          row({ productId: "a", productName: "Aynı Ad" }),
          row({ productId: "c", productName: "Aynı Ad" }),
        ],
        issues: [
          issue({ productId: "a", severity: "warning", code: "missing_image" }),
          issue({ productId: "b", severity: "warning", code: "missing_image" }),
          issue({ productId: "c", severity: "warning", code: "missing_image" }),
        ],
      }),
    );

    for (const sort of ["severity", "name", "updated"] as const) {
      expect(ids(selectProductTableRows(tied, { sort, page: 1, search: "" }))).toEqual([
        "a",
        "b",
        "c",
      ]);
    }
  });

  it("filters by the selected rule", () => {
    const result = selectProductTableRows(rows, { sort: "severity", page: 1, search: "", rule: "out_of_stock" });

    expect(ids(result)).toEqual(["p2"]);
    expect(result.totalRows).toBe(1);
  });

  it("searches product names case-insensitively with Turkish casing", () => {
    expect(ids(selectProductTableRows(rows, { sort: "severity", page: 1, search: "ÇORAP" }))).toEqual([
      "p3",
    ]);
    expect(ids(selectProductTableRows(rows, { sort: "severity", page: 1, search: "kazak" }))).toEqual([
      "p1",
    ]);
  });

  it("applies rule filter and search together", () => {
    const result = selectProductTableRows(rows, {
      sort: "severity",
      page: 1,
      search: "zebra",
      rule: "out_of_stock",
    });

    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it("summarises severity over the whole filtered set, not just the rendered page", () => {
    const many = buildProductIssueRows(
      report({
        productRows: Array.from({ length: PRODUCT_TABLE_PAGE_SIZE + 5 }, (_, index) =>
          row({ productId: `p${index}` }),
        ),
        issues: Array.from({ length: PRODUCT_TABLE_PAGE_SIZE + 5 }, (_, index) =>
          issue({
            productId: `p${index}`,
            code: "missing_sku",
            severity: index === 0 ? "critical" : "warning",
          }),
        ),
      }),
    );

    const result = selectProductTableRows(many, { sort: "severity", page: 1, search: "" });

    expect(result.rows).toHaveLength(PRODUCT_TABLE_PAGE_SIZE);
    expect(result.severityCounts).toEqual({ critical: 1, warning: PRODUCT_TABLE_PAGE_SIZE + 4, info: 0 });
  });

  it("bounds rendering to one page and reports a stable range", () => {
    const many = buildProductIssueRows(
      report({
        productRows: Array.from({ length: 60 }, (_, index) => row({ productId: `p${index}` })),
        issues: Array.from({ length: 60 }, (_, index) =>
          issue({ productId: `p${index}`, code: "missing_sku", severity: "warning" }),
        ),
      }),
    );

    const second = selectProductTableRows(many, { sort: "name", page: 2, search: "" });

    expect(second.rows).toHaveLength(PRODUCT_TABLE_PAGE_SIZE);
    expect(second.page).toBe(2);
    expect(second.pageCount).toBe(Math.ceil(60 / PRODUCT_TABLE_PAGE_SIZE));
    expect(second.rangeStart).toBe(PRODUCT_TABLE_PAGE_SIZE + 1);
    expect(second.rangeEnd).toBe(PRODUCT_TABLE_PAGE_SIZE * 2);
    expect(second.totalRows).toBe(60);
  });

  it("clamps a page past the end back onto the last page instead of rendering nothing", () => {
    const result = selectProductTableRows(rows, { sort: "name", page: 99, search: "" });

    expect(result.page).toBe(1);
    expect(result.rows).toHaveLength(3);
  });

  it("reports one empty page for an empty result set", () => {
    const result = selectProductTableRows([], { sort: "name", page: 1, search: "" });

    expect(result).toMatchObject({ page: 1, pageCount: 1, totalRows: 0, rangeStart: 0, rangeEnd: 0 });
  });
});
