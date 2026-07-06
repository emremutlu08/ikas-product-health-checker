import { issuesToCsv } from "./csv";
import { buildHealthReport } from "./health-rules";
import { createProductAdapter } from "./product-adapter";
import type { HealthReport } from "./types";

export type ProductHealthReportResult = {
  source: "mock" | "http";
  report: HealthReport;
};

export async function getProductHealthReport(now = new Date()): Promise<ProductHealthReportResult> {
  const adapter = createProductAdapter();
  const { source, products } = await adapter.listProducts();
  return { source, report: buildHealthReport(products, now) };
}

export async function getProductHealthReportCsv() {
  const { report } = await getProductHealthReport();
  return issuesToCsv(report.issues);
}
