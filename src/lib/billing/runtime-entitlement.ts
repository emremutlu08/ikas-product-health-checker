import { config } from "@/globals/config";
import { getIkasToken } from "@/lib/ikas/token-store";
import {
  tokenMatchesInstallation,
  type InstallationIdentity,
} from "@/lib/ikas/installation-auth";
import { HttpIkasLicenceAdapter } from "@/lib/ikas/licence-adapter";
import {
  resolveLiveEntitlement,
  type Entitlement,
  type EntitlementLogger,
  type LicenceReader,
} from "./entitlement-service";
import { isFeatureEnabled, type AppFeature } from "./feature-policy";
import type { SnapshotRetentionPolicy } from "@/lib/scans/snapshot-store";

export type RuntimeEntitlementDependencies = {
  getToken: typeof getIkasToken;
  createReader(accessToken: string): LicenceReader;
  logger?: EntitlementLogger;
};

const defaultLogger: EntitlementLogger = {
  warn(warning) {
    // The entitlement service constrains this payload to operator-owned identifiers and never
    // includes an access token, header or raw upstream response.
    console.warn(JSON.stringify(warning));
  },
};

const defaultDependencies: RuntimeEntitlementDependencies = {
  getToken: getIkasToken,
  createReader: (accessToken) =>
    new HttpIkasLicenceAdapter(config.graphApiUrl, accessToken),
  logger: defaultLogger,
};

function unavailableEntitlement(
  installation: InstallationIdentity,
  state: "unknown" | "denied" = "unknown",
): Entitlement {
  return {
    authorizedAppId: installation.authorizedAppId,
    merchantId: null,
    tier: "free",
    state,
    reason: state === "denied" ? "MERCHANT_MISMATCH" : "LICENCE_UNAVAILABLE",
  };
}

/**
 * Resolves a live, tenant-bound entitlement using only the sealed installation and its durable
 * token. Missing/crossed tokens and backend failures never grant Pro and never throw into the
 * Free manual-scan path.
 */
export async function resolveInstallationEntitlement(
  installation: InstallationIdentity,
  dependencies: RuntimeEntitlementDependencies = defaultDependencies,
): Promise<Entitlement> {
  let token;
  try {
    token = await dependencies.getToken(installation.authorizedAppId);
  } catch {
    return unavailableEntitlement(installation);
  }

  if (!token) return unavailableEntitlement(installation);
  if (!tokenMatchesInstallation(token, installation)) {
    return unavailableEntitlement(installation, "denied");
  }

  const reader = dependencies.createReader(token.accessToken);
  return resolveLiveEntitlement(
    reader,
    {
      authorizedAppId: installation.authorizedAppId,
      merchantId: installation.merchantId,
    },
    { logger: dependencies.logger },
  );
}

/** Active state is checked in addition to tier so an untyped or future caller cannot treat a
 * cached/unknown Pro-shaped value as a grant. */
export async function isInstallationFeatureEnabled(
  installation: InstallationIdentity,
  feature: AppFeature,
  dependencies: RuntimeEntitlementDependencies = defaultDependencies,
): Promise<boolean> {
  const entitlement = await resolveInstallationEntitlement(installation, dependencies);
  return entitlement.state === "active" && isFeatureEnabled(feature, entitlement.tier);
}

/** Explicit per-scan storage decision. Default and every non-Pro outcome remain latest-only. */
export async function resolveInstallationRetentionPolicy(
  installation: InstallationIdentity,
  dependencies: RuntimeEntitlementDependencies = defaultDependencies,
): Promise<SnapshotRetentionPolicy> {
  return {
    historyEnabled: await isInstallationFeatureEnabled(
      installation,
      "scan-history",
      dependencies,
    ),
  };
}
