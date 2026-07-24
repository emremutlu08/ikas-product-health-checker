import { isFeatureEnabled } from "@/lib/billing/feature-policy";
import { resolveInstallationEntitlement } from "@/lib/billing/runtime-entitlement";
import type { Entitlement } from "@/lib/billing/entitlement-service";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import type { SnapshotRetentionPolicy } from "@/lib/scans/snapshot-store";
import {
  DEFAULT_MONITORING_SETTINGS,
  getTenantMonitoringSettings,
  parseMonitoringSettings,
  putTenantMonitoringSettings,
  type MonitoringSettings,
  type SettingsTenant,
} from "./settings-store";

/**
 * The active-Pro boundary in front of tenant monitoring settings, and the single entitlement
 * decision that drives a scan.
 *
 * Reading and mutating settings are both Pro-only. The scan policy resolves the licence exactly
 * once and derives history retention and the effective low-stock threshold from that one answer,
 * so an ordinary dashboard render — which never calls any of this — pays for no licence read.
 * Every non-active-Pro outcome, and every settings outage, fails closed.
 */

export class SettingsAccessError extends Error {
  readonly code = "IKAS_PRO_FEATURE_REQUIRED" as const;

  constructor() {
    super("IKAS_PRO_FEATURE_REQUIRED");
    this.name = "SettingsAccessError";
  }
}

export class SettingsValidationError extends Error {
  readonly code = "IKAS_SETTINGS_INVALID" as const;

  constructor() {
    super("IKAS_SETTINGS_INVALID");
    this.name = "SettingsValidationError";
  }
}

export type MonitoringSettingsServiceDependencies = {
  resolveEntitlement(installation: InstallationIdentity): Promise<Entitlement>;
  getSettings(tenant: SettingsTenant): Promise<MonitoringSettings | undefined>;
  putSettings(tenant: SettingsTenant, settings: MonitoringSettings): Promise<void>;
};

const defaultDependencies: MonitoringSettingsServiceDependencies = {
  resolveEntitlement: resolveInstallationEntitlement,
  getSettings: getTenantMonitoringSettings,
  putSettings: putTenantMonitoringSettings,
};

export type MonitoringSettingsView = {
  tier: "pro";
  settings: MonitoringSettings;
};

export type ScanExecutionPolicy = {
  retention: SnapshotRetentionPolicy;
  /** 0 unless an active Pro grant and a stored configuration both say otherwise. */
  lowStockThreshold: number;
};

function tenantOf(installation: InstallationIdentity): SettingsTenant {
  return { authorizedAppId: installation.authorizedAppId, merchantId: installation.merchantId };
}

/**
 * Whether the merchant may see or change monitoring settings at all. Both knobs on the settings
 * page are Pro features, so a single active-Pro check gates the whole surface. An untyped caller
 * cannot slip an inactive Pro-shaped entitlement through because `state` is checked too.
 */
function hasActiveProSettingsAccess(entitlement: Entitlement): boolean {
  return (
    entitlement.state === "active" &&
    isFeatureEnabled("low-stock-threshold-config", entitlement.tier)
  );
}

async function requireActiveProInstallation(
  installation: InstallationIdentity | null | undefined,
  dependencies: MonitoringSettingsServiceDependencies,
): Promise<void> {
  if (!installation) throw new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED");
  const entitlement = await dependencies.resolveEntitlement(installation);
  if (!hasActiveProSettingsAccess(entitlement)) throw new SettingsAccessError();
}

export async function readMonitoringSettings(
  installation?: InstallationIdentity | null,
  dependencies: MonitoringSettingsServiceDependencies = defaultDependencies,
): Promise<MonitoringSettingsView> {
  await requireActiveProInstallation(installation, dependencies);
  const stored = await dependencies.getSettings(tenantOf(installation!));
  return { tier: "pro", settings: stored ?? { ...DEFAULT_MONITORING_SETTINGS } };
}

export async function updateMonitoringSettings(
  installation: InstallationIdentity | null | undefined,
  input: unknown,
  dependencies: MonitoringSettingsServiceDependencies = defaultDependencies,
): Promise<MonitoringSettingsView> {
  await requireActiveProInstallation(installation, dependencies);

  // Validated before any write. `parseMonitoringSettings` only accepts the two settings fields,
  // so a client-supplied tenant selector in the same body is structurally ignored.
  const settings = parseMonitoringSettings(input);
  if (!settings) throw new SettingsValidationError();

  await dependencies.putSettings(tenantOf(installation!), settings);
  return { tier: "pro", settings };
}

/**
 * One entitlement decision drives an entire scan. History retention and the low-stock threshold
 * both derive from the same licence answer, so a Free, unknown, inactive or mismatched
 * installation gets latest-only storage and threshold 0 even if stale paid settings still exist.
 * A settings-store outage for a confirmed Pro merchant degrades only the threshold to 0; history
 * retention still follows the known-good entitlement, and the manual scan is never blocked.
 */
export async function resolveInstallationScanPolicy(
  installation: InstallationIdentity,
  dependencies: MonitoringSettingsServiceDependencies = defaultDependencies,
): Promise<ScanExecutionPolicy> {
  let entitlement: Entitlement;
  try {
    entitlement = await dependencies.resolveEntitlement(installation);
  } catch {
    // The runtime resolver is fail-closed and does not throw, but a future/injected reader might;
    // an unresolved licence is never a grant.
    return { retention: { historyEnabled: false }, lowStockThreshold: 0 };
  }

  const active = entitlement.state === "active";
  const historyEnabled = active && isFeatureEnabled("scan-history", entitlement.tier);
  const thresholdConfigurable =
    active && isFeatureEnabled("low-stock-threshold-config", entitlement.tier);

  if (!thresholdConfigurable) {
    return { retention: { historyEnabled }, lowStockThreshold: 0 };
  }

  let lowStockThreshold = DEFAULT_MONITORING_SETTINGS.lowStockThreshold;
  try {
    const settings = await dependencies.getSettings(tenantOf(installation));
    lowStockThreshold = settings?.lowStockThreshold ?? DEFAULT_MONITORING_SETTINGS.lowStockThreshold;
  } catch {
    // A settings outage must not block the scan; it degrades to the safe default threshold.
    lowStockThreshold = 0;
  }

  return { retention: { historyEnabled }, lowStockThreshold };
}
