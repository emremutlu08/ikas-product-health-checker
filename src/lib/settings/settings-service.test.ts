import { beforeEach, describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import type { Entitlement } from "@/lib/billing/entitlement-service";
import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import { MonitoringSettingsStoreError } from "./settings-store";
import {
  readMonitoringSettings,
  resolveInstallationScanPolicy,
  SettingsAccessError,
  SettingsValidationError,
  updateMonitoringSettings,
  type MonitoringSettingsServiceDependencies,
} from "./settings-service";

const installation: InstallationIdentity = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "dev-store",
};

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    authorizedAppId: "app-1",
    merchantId: "merchant-1",
    tier: "pro",
    state: "active",
    reason: "ACTIVE_KNOWN_PLAN",
    ...overrides,
  };
}

function deps(overrides: Partial<MonitoringSettingsServiceDependencies> = {}) {
  return {
    resolveEntitlement: vi.fn().mockResolvedValue(entitlement()),
    getSettings: vi.fn().mockResolvedValue(undefined),
    putSettings: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } satisfies MonitoringSettingsServiceDependencies;
}

const nonProStates: Array<Partial<Entitlement>> = [
  { tier: "free", state: "inactive", reason: "NO_MATCHING_SUBSCRIPTION" },
  { tier: "free", state: "unknown", reason: "LICENCE_UNAVAILABLE" },
  { tier: "free", state: "denied", reason: "MERCHANT_MISMATCH" },
  // A Pro tier that is not active must not unlock settings.
  { tier: "pro", state: "unknown", reason: "LICENCE_NETWORK_UNAVAILABLE" },
];

beforeEach(() => vi.clearAllMocks());

describe("readMonitoringSettings", () => {
  it("returns the stored settings for an active Pro merchant", async () => {
    const dependencies = deps({
      getSettings: vi.fn().mockResolvedValue({ lowStockThreshold: 15, dailyEmailEnabled: true }),
    });

    await expect(readMonitoringSettings(installation, dependencies)).resolves.toEqual({
      tier: "pro",
      settings: { lowStockThreshold: 15, dailyEmailEnabled: true },
    });
    expect(dependencies.getSettings).toHaveBeenCalledWith({
      authorizedAppId: "app-1",
      merchantId: "merchant-1",
    });
  });

  it("applies fail-closed defaults when nothing is stored yet", async () => {
    await expect(readMonitoringSettings(installation, deps())).resolves.toEqual({
      tier: "pro",
      settings: { lowStockThreshold: 0, dailyEmailEnabled: false },
    });
  });

  it.each(nonProStates)("denies a non-active-Pro merchant (%o)", async (state) => {
    const dependencies = deps({ resolveEntitlement: vi.fn().mockResolvedValue(entitlement(state)) });
    await expect(readMonitoringSettings(installation, dependencies)).rejects.toBeInstanceOf(
      SettingsAccessError,
    );
    expect(dependencies.getSettings).not.toHaveBeenCalled();
  });

  it("requires a server-side installation session", async () => {
    await expect(readMonitoringSettings(undefined, deps())).rejects.toBeInstanceOf(
      IkasAuthenticationError,
    );
  });

  it("surfaces a settings backend failure rather than a fabricated default", async () => {
    const dependencies = deps({
      getSettings: vi.fn().mockRejectedValue(new MonitoringSettingsStoreError("backend", "get")),
    });
    await expect(readMonitoringSettings(installation, dependencies)).rejects.toBeInstanceOf(
      MonitoringSettingsStoreError,
    );
  });
});

describe("updateMonitoringSettings", () => {
  it("persists validated settings for an active Pro merchant and ignores extra fields", async () => {
    const dependencies = deps();

    await expect(
      updateMonitoringSettings(
        installation,
        {
          lowStockThreshold: 42,
          dailyEmailEnabled: true,
          authorizedAppId: "attacker-app",
          merchantId: "attacker-merchant",
        } as never,
        dependencies,
      ),
    ).resolves.toEqual({ tier: "pro", settings: { lowStockThreshold: 42, dailyEmailEnabled: true } });

    expect(dependencies.putSettings).toHaveBeenCalledWith(
      { authorizedAppId: "app-1", merchantId: "merchant-1" },
      { lowStockThreshold: 42, dailyEmailEnabled: true },
    );
  });

  it.each([
    { lowStockThreshold: -1, dailyEmailEnabled: false },
    { lowStockThreshold: 1001, dailyEmailEnabled: false },
    { lowStockThreshold: 1.5, dailyEmailEnabled: false },
    { lowStockThreshold: "5", dailyEmailEnabled: false },
    { lowStockThreshold: 5, dailyEmailEnabled: "yes" },
    { dailyEmailEnabled: false },
  ])("rejects invalid input without writing (%o)", async (input) => {
    const dependencies = deps();
    await expect(
      updateMonitoringSettings(installation, input as never, dependencies),
    ).rejects.toBeInstanceOf(SettingsValidationError);
    expect(dependencies.putSettings).not.toHaveBeenCalled();
  });

  it.each(nonProStates)("denies mutation for a non-active-Pro merchant (%o)", async (state) => {
    const dependencies = deps({ resolveEntitlement: vi.fn().mockResolvedValue(entitlement(state)) });
    await expect(
      updateMonitoringSettings(
        installation,
        { lowStockThreshold: 5, dailyEmailEnabled: true },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(SettingsAccessError);
    expect(dependencies.putSettings).not.toHaveBeenCalled();
  });
});

describe("resolveInstallationScanPolicy", () => {
  it("grants history and the configured threshold to an active Pro merchant", async () => {
    const dependencies = deps({
      getSettings: vi.fn().mockResolvedValue({ lowStockThreshold: 20, dailyEmailEnabled: true }),
    });

    await expect(resolveInstallationScanPolicy(installation, dependencies)).resolves.toEqual({
      retention: { historyEnabled: true },
      lowStockThreshold: 20,
    });
    expect(dependencies.resolveEntitlement).toHaveBeenCalledOnce();
  });

  it("defaults an active Pro merchant with no stored settings to threshold 0", async () => {
    await expect(resolveInstallationScanPolicy(installation, deps())).resolves.toEqual({
      retention: { historyEnabled: true },
      lowStockThreshold: 0,
    });
  });

  it.each(nonProStates)(
    "downgrades a non-active-Pro merchant to latest-only and threshold 0 (%o)",
    async (state) => {
      const dependencies = deps({
        resolveEntitlement: vi.fn().mockResolvedValue(entitlement(state)),
        getSettings: vi.fn().mockResolvedValue({ lowStockThreshold: 500, dailyEmailEnabled: true }),
      });

      await expect(resolveInstallationScanPolicy(installation, dependencies)).resolves.toEqual({
        retention: { historyEnabled: false },
        lowStockThreshold: 0,
      });
      // A non-Pro decision never reads stale paid settings.
      expect(dependencies.getSettings).not.toHaveBeenCalled();
    },
  );

  it("keeps history but falls back to threshold 0 when the settings store is unavailable", async () => {
    const dependencies = deps({
      getSettings: vi.fn().mockRejectedValue(new MonitoringSettingsStoreError("backend", "get")),
    });

    await expect(resolveInstallationScanPolicy(installation, dependencies)).resolves.toEqual({
      retention: { historyEnabled: true },
      lowStockThreshold: 0,
    });
  });
});
