import { issuesToCsv } from "./csv";
import { buildHealthReport } from "./health-rules";
import { config } from "@/globals/config";
import { getSession } from "@/lib/session";
import { getIkasToken, invalidateIkasToken } from "./token-store";
import { HttpIkasProductAdapter } from "./product-adapter";
import type { HealthReport } from "./types";

export type ProductHealthReportResult = {
  source: "http";
  report: HealthReport;
};

export async function getProductHealthReport(now = new Date(), authorizedAppId?: string | null): Promise<ProductHealthReportResult> {
  const storedToken = await getIkasToken(authorizedAppId);
  const session = await getSession().catch(() => undefined);
  const liveToken = authorizedAppId ? storedToken?.accessToken : session?.accessToken;
  if (!liveToken) {
    throw new Error("IKAS_LIVE_AUTH_REQUIRED");
  }

  const adapter = new HttpIkasProductAdapter(config.graphApiUrl, liveToken);
  try {
    const { products } = await adapter.listProducts();
    return { source: "http", report: buildHealthReport(products, now) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (authorizedAppId && message.includes("LOGIN_REQUIRED")) {
      await invalidateIkasToken(authorizedAppId);
    }
    throw error;
  }
}

export async function getProductHealthReportCsv(authorizedAppId?: string | null) {
  const { report } = await getProductHealthReport(new Date(), authorizedAppId);
  return issuesToCsv(report.issues);
}
