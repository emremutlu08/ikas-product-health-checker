import { describe, expect, it } from "vitest";
import type { CorrectableTarget } from "@/components/CorrectionPanel";
import {
  buildCorrectionHref,
  CORRECTION_PAGE_SIZE,
  MAX_CORRECTION_PAGE,
  MAX_CORRECTION_SEARCH_LENGTH,
  parseCorrectionQuery,
  selectCorrections,
} from "./correction-list";

function target(index: number, overrides: Partial<CorrectableTarget> = {}): CorrectableTarget {
  return {
    productId: `product-${index}`,
    productName: `Ürün ${index}`,
    variantId: `variant-${index}`,
    kind: "sku_change",
    issueMessage: "Aktif varyantta SKU eksik.",
    currentValue: "",
    imageLabel: "ÜR",
    ...overrides,
  };
}

const many = Array.from({ length: 130 }, (_, index) => target(index));

describe("parseCorrectionQuery", () => {
  it("defaults to the first page with no search", () => {
    expect(parseCorrectionQuery({})).toEqual({ search: "", page: 1 });
  });

  it("bounds a crafted page number instead of trusting it", () => {
    expect(parseCorrectionQuery({ page: "999999999" }).page).toBe(MAX_CORRECTION_PAGE);
    for (const page of ["0", "-3", "abc", "1e5", ""]) {
      expect(parseCorrectionQuery({ page }).page, page).toBe(1);
    }
  });

  it("bounds a pasted search term", () => {
    const long = "x".repeat(MAX_CORRECTION_SEARCH_LENGTH + 50);

    expect(parseCorrectionQuery({ q: long }).search).toHaveLength(MAX_CORRECTION_SEARCH_LENGTH);
  });

  /**
   * A repeated parameter is ambiguous. Picking one would silently apply a filter the merchant
   * cannot see in the URL they typed, so the default applies instead.
   */
  it("ignores a repeated parameter rather than picking one", () => {
    expect(parseCorrectionQuery({ q: ["a", "b"], page: ["2", "3"] })).toEqual({
      search: "",
      page: 1,
    });
  });
});

describe("selectCorrections", () => {
  it("returns one page of fifty and reports the range", () => {
    const selection = selectCorrections(many, { search: "", page: 1 });

    expect(CORRECTION_PAGE_SIZE).toBe(50);
    expect(selection.targets).toHaveLength(50);
    expect(selection.totalTargets).toBe(130);
    expect(selection.pageCount).toBe(3);
    expect(selection.rangeStart).toBe(1);
    expect(selection.rangeEnd).toBe(50);
  });

  it("returns the remainder on the last page", () => {
    const selection = selectCorrections(many, { search: "", page: 3 });

    expect(selection.targets).toHaveLength(30);
    expect(selection.rangeStart).toBe(101);
    expect(selection.rangeEnd).toBe(130);
  });

  /**
   * A link can outlive the issues behind it — a scan fixes things, the list shrinks. Landing on an
   * empty screen would read as "you have no corrections" when the truth is "not on that page".
   */
  it("clamps a page past the end onto the last page", () => {
    const selection = selectCorrections(many, { search: "", page: 99 });

    expect(selection.page).toBe(3);
    expect(selection.targets).toHaveLength(30);
  });

  it("searches product and variant names, and paginates what matched", () => {
    const targets = [
      target(1, { productName: "İpek Eşarp" }),
      target(2, { productName: "Basic Cap", variantLabel: "Siyah" }),
      target(3, { productName: "Daily Backpack" }),
    ];

    const found = selectCorrections(targets, { search: "ipek", page: 1 });
    expect(found.targets.map((item) => item.productName)).toEqual(["İpek Eşarp"]);
    expect(found.totalTargets).toBe(1);
    // The unfiltered figure stays available, so the screen can say "1 / 3" rather than just "1".
    expect(found.unfilteredTargets).toBe(3);

    const byVariant = selectCorrections(targets, { search: "siyah", page: 1 });
    expect(byVariant.targets.map((item) => item.productName)).toEqual(["Basic Cap"]);
  });

  it("reports an empty range when nothing matched", () => {
    const selection = selectCorrections(many, { search: "hiçbir şey", page: 1 });

    expect(selection.targets).toEqual([]);
    expect(selection.totalTargets).toBe(0);
    expect(selection.pageCount).toBe(1);
    expect(selection.rangeStart).toBe(0);
    expect(selection.rangeEnd).toBe(0);
  });
});

describe("buildCorrectionHref", () => {
  it("omits defaults so the unfiltered list has a clean URL", () => {
    expect(buildCorrectionHref({ search: "", page: 1 }, {})).toBe("/corrections");
  });

  it("carries the search across pages", () => {
    expect(buildCorrectionHref({ search: "kap", page: 1 }, { page: "2" })).toBe(
      "/corrections?q=kap&page=2",
    );
  });

  /**
   * A new search must not keep the old page number: page 4 of the previous result set is almost
   * never a page of the new one, and the merchant would see an empty screen.
   */
  it("drops the page when the patch clears it", () => {
    expect(buildCorrectionHref({ search: "kap", page: 4 }, { q: "çanta", page: undefined })).toBe(
      "/corrections?q=%C3%A7anta",
    );
  });
});
