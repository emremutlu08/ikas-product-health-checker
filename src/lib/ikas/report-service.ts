import { issuesToCsv } from "./csv";
import { buildHealthReport } from "./health-rules";
import { config } from "@/globals/config";
import { getIkasToken, invalidateIkasToken } from "./token-store";
import { HttpIkasProductAdapter, type IkasProductAdapter } from "./product-adapter";
import { IkasAuthenticationError } from "./errors";
import type { HealthReport } from "./types";
import { tokenMatchesInstallation, type InstallationIdentity } from "./installation-auth";

export type ProductHealthReportResult = {
  source: "http";
  report: HealthReport;
};

export type ProductHealthReportDependencies = {
  getToken: typeof getIkasToken;
  invalidateToken: typeof invalidateIkasToken;
  createAdapter(endpoint: string, accessToken: string): IkasProductAdapter;
};

const defaultDependencies: ProductHealthReportDependencies = {
  getToken: getIkasToken,
  invalidateToken: invalidateIkasToken,
  createAdapter: (endpoint, accessToken) => new HttpIkasProductAdapter(endpoint, accessToken),
};

export async function getProductHealthReport(
  now = new Date(),
  installation?: InstallationIdentity | null,
  dependencies: ProductHealthReportDependencies = defaultDependencies,
): Promise<ProductHealthReportResult> {
  if (!installation) throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");

  const storedToken = await dependencies.getToken(installation.authorizedAppId);
  if (!tokenMatchesInstallation(storedToken, installation)) {
    throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");
  }

  const adapter = dependencies.createAdapter(config.graphApiUrl, storedToken.accessToken);
  try {
    const { products } = await adapter.listProducts();
    return { source: "http", report: buildHealthReport(products, now, { merchantId: storedToken.merchantId }) };
  } catch (error) {
    if (error instanceof IkasAuthenticationError) {
      await dependencies.invalidateToken(installation.authorizedAppId, storedToken);
    }
    throw error;
  }
}

export async function getProductHealthReportCsv(installation?: InstallationIdentity | null) {
  const { report } = await getProductHealthReport(new Date(), installation);
  return issuesToCsv(report.issues);
}
