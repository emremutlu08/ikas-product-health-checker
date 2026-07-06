import { issuesToCsv } from "./csv";
import { buildHealthReport } from "./health-rules";
import { config } from "@/globals/config";
import { getSession } from "@/lib/session";
import { createProductAdapter, HttpIkasProductAdapter } from "./product-adapter";
import type { HealthReport } from "./types";

export type ProductHealthReportResult = {
  source: "mock" | "http";
  report: HealthReport;
};

export async function getProductHealthReport(now = new Date()): Promise<ProductHealthReportResult> {
  const session = await getSession().catch(() => undefined);
  const adapter = session?.accessToken
    ? new HttpIkasProductAdapter(config.graphApiUrl, session.accessToken)
    : createProductAdapter();
  const { source, products } = await adapter.listProducts();
  return { source, report: buildHealthReport(products, now) };
}

export async function getProductHealthReportCsv() {
  const { report } = await getProductHealthReport();
  return issuesToCsv(report.issues);
}
