import { describe, expect, it } from "vitest";
import { buildHealthReport } from "./health-rules";
import { issuesToCsv } from "./csv";
import { sampleProducts } from "./sample-products";

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

  it("reports blocked out-of-stock variants under a name that matches what is measured", () => {
    expect(report.outOfStockBlockedCount).toBe(report.issueCountsByCode.zero_stock_blocked);
    expect(report.outOfStockBlockedCount).toBe(1);
    // No configurable low-stock threshold exists yet, so no field may imply one.
    expect(report).not.toHaveProperty("lowStockRiskCount");
  });

  it("preserves health score and rule behaviour while the stock metric is renamed", () => {
    expect(report.score).toBe(41);
    expect(report.criticalCount).toBe(5);
    expect(report.warningCount).toBe(7);
    expect(report.infoCount).toBe(3);
    expect(report.ruleSummaries.find((rule) => rule.code === "out_of_stock")?.count).toBe(1);
  });

  it("builds mistake finder rule summaries and product rows", () => {
    expect(report.affectedProductCount).toBeGreaterThan(0);
    expect(report.ruleSummaries.find((rule) => rule.code === "incorrect_price")?.count).toBe(1);
    expect(report.ruleSummaries.find((rule) => rule.code === "out_of_stock")?.count).toBe(1);
    expect(report.ruleSummaries.find((rule) => rule.code === "same_sku")?.count).toBe(2);
    expect(report.productRows.some((row) => row.productName === "Silver Ring" && row.mistakes.includes("Hatalı Fiyat"))).toBe(true);
  });
});

describe("issuesToCsv", () => {
  it("exports issue rows as csv", () => {
    const csv = issuesToCsv(report.issues);
    expect(csv.split("\n")[0]).toBe("severity,code,productName,productId,variantLabel,variantId,value,message");
    expect(csv).toContain("duplicate_sku");
    expect(csv).toContain("Silver Ring");
  });
});
