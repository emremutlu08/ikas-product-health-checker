import { issuesToCsv } from "./csv";
import { buildHealthReport } from "./health-rules";
import { config } from "@/globals/config";
import { getSession } from "@/lib/session";
import { getIkasToken } from "./token-store";
import { createProductAdapter, HttpIkasProductAdapter } from "./product-adapter";
import type { HealthReport } from "./types";

export type ProductHealthReportResult = {
  source: "mock" | "http";
  report: HealthReport;
};

export async function getProductHealthReport(now = new Date(), authorizedAppId?: string | null): Promise<ProductHealthReportResult> {
  const storedToken = await getIkasToken(authorizedAppId);
  const session = await getSession().catch(() => undefined);
  const liveToken = authorizedAppId ? storedToken?.accessToken : session?.accessToken;
  const adapter = liveToken
    ? new HttpIkasProductAdapter(config.graphApiUrl, liveToken)
    : createProductAdapter();
  const { source, products } = await adapter.listProducts();
  return { source, report: buildHealthReport(products, now) };
}

export async function getProductHealthReportCsv(authorizedAppId?: string | null) {
  const { report } = await getProductHealthReport(new Date(), authorizedAppId);
  return issuesToCsv(report.issues);
}
