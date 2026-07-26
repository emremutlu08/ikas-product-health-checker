import { config } from "@/globals/config";
import { isInstallationFeatureEnabled } from "@/lib/billing/runtime-entitlement";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import { tokenMatchesInstallation, type InstallationIdentity } from "@/lib/ikas/installation-auth";
import { HttpIkasProductAdapter } from "@/lib/ikas/product-adapter";
import { HttpIkasProductWriter, type IkasProductWriter } from "@/lib/ikas/product-writer";
import { sharedIkasRequestLimiter } from "@/lib/ikas/request-limiter";
import { getIkasToken } from "@/lib/ikas/token-store";
import type { IkasProduct } from "@/lib/ikas/types";
import { getLatestProductHealthReport } from "@/lib/ikas/report-service";
import { mutationOperationStore } from "./mutation-operation-store";

/**
 * Assembling the real dependencies for a confirmed correction.
 *
 * Routes stay thin and testable by taking their dependencies as arguments; this is the one place
 * that turns a sealed installation into a live reader, a live writer and the durable store. The
 * production write surface is default-off: it opens only when an operator sets the server-only
 * kill switch *and* the merchant holds a live `product-corrections-write` grant.
 */

export const PRODUCT_WRITE_KILL_SWITCH_ENV = "IKAS_PRODUCT_WRITES_ENABLED";

/**
 * Default-off, and deliberately not derived from `NODE_ENV`: shipping the code must never be the
 * thing that opens a merchant write surface. The development-store canary is what earns this flag.
 */
export function productWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PRODUCT_WRITE_KILL_SWITCH_ENV]?.trim() === "true";
}

export const BULK_WRITE_KILL_SWITCH_ENV = "IKAS_PRODUCT_BULK_WRITES_ENABLED";

/**
 * Bulk has its own switch and additionally requires the single-write switch: proving one confirmed
 * correction is safe is a precondition for running many, never a substitute for it.
 */
export function bulkWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return productWritesEnabled(env) && env[BULK_WRITE_KILL_SWITCH_ENV]?.trim() === "true";
}

export type CorrectionRuntime = {
  readProduct(productId: string): Promise<IkasProduct | undefined>;
  writer: IkasProductWriter;
};

async function tenantAccessToken(installation: InstallationIdentity) {
  const token = await getIkasToken(installation.authorizedAppId);
  if (!tokenMatchesInstallation(token, installation)) {
    throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");
  }
  return token.accessToken;
}

export async function createCorrectionRuntime(
  installation: InstallationIdentity,
): Promise<CorrectionRuntime> {
  const accessToken = await tenantAccessToken(installation);
  const adapter = new HttpIkasProductAdapter(config.graphApiUrl, accessToken, 1);
  return {
    readProduct: (productId) => adapter.getProductById(productId),
    writer: new HttpIkasProductWriter(
      config.graphApiUrl,
      accessToken,
      // ikas rate-limits and blocks per store, so the budget and the circuit are per installation.
      sharedIkasRequestLimiter(installation.authorizedAppId),
    ),
  };
}

/** Read-only dependencies, used by preview and status where no write may happen. */
export async function createCorrectionReadRuntime(installation: InstallationIdentity) {
  const accessToken = await tenantAccessToken(installation);
  const adapter = new HttpIkasProductAdapter(config.graphApiUrl, accessToken, 1);
  return {
    getLatestReport: getLatestProductHealthReport,
    readProduct: (productId: string) => adapter.getProductById(productId),
    operationStore: mutationOperationStore(),
    createOperationId: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
}

export function hasCorrectionWriteFeature(installation: InstallationIdentity) {
  return isInstallationFeatureEnabled(installation, "product-corrections-write");
}

/** Bulk names its own capability, so the grant the plan surface advertises is the one enforced. */
export function hasBulkWriteFeature(installation: InstallationIdentity) {
  return isInstallationFeatureEnabled(installation, "bulk-corrections-write");
}
