import { describe, expect, it, vi } from "vitest";
import type { ScanSnapshot } from "@/lib/scans/snapshot-store";
import { runDailyMonitoring, type DailyMonitoringDependencies } from "./daily-monitoring";
import type { MonitoringRunClaim } from "./schedule-store";

const NOW = new Date("2026-07-22T10:00:00.000Z");
const installations = Array.from({ length: 8 }, (_, index) => ({
  authorizedAppId: `app-${index + 1}`,
  merchantId: `merchant-${index + 1}`,
  storeName: `store-${index + 1}`,
}));

function snapshotFor(index: number): ScanSnapshot {
  return {
    version: 1,
    scanId: `scan-${index}`,
    authorizedAppId: `app-${index}`,
    merchantId: `merchant-${index}`,
    generatedAt: NOW.toISOString(),
    report: {
      generatedAt: NOW.toISOString(), score: 82, productCount: 12, variantCount: 15,
      issueCount: 4, affectedProductCount: 3, scanStatus: "success",
      issueCountsByCode: {
        missing_sku: 1, missing_barcode: 0, duplicate_sku: 0, duplicate_barcode: 0,
        missing_image: 0, missing_description: 0, missing_category: 0, missing_brand: 0,
        missing_vendor: 0, zero_stock_blocked: 0, low_stock: 2, missing_price: 1,
        duplicate_title: 0, weird_description: 0,
      },
      criticalCount: 1, warningCount: 3, infoCount: 0, outOfStockBlockedCount: 0,
      ruleSummaries: [], productRows: [], issues: [],
    },
  };
}

function scanResultFor(index: number) {
  return {
    snapshot: snapshotFor(index),
    observationSet: { observations: [], truncated: false },
  };
}

function claimFor(installation: (typeof installations)[number], ownerId = "run-owner"): MonitoringRunClaim {
  return {
    tenant: { authorizedAppId: installation.authorizedAppId, merchantId: installation.merchantId },
    ownerId,
    deliveryId: "delivery-window-1",
  };
}

function fixture(overrides: Partial<DailyMonitoringDependencies> = {}): DailyMonitoringDependencies {
  return {
    listInstallations: vi.fn().mockResolvedValue(installations),
    claimIfDue: vi.fn(async (installation, ownerId) => claimFor(installation, ownerId)),
    completeRun: vi.fn().mockResolvedValue(true),
    releaseRun: vi.fn().mockResolvedValue(true),
    resolveMonitoring: vi.fn().mockResolvedValue({ lowStockThreshold: 7, dailyEmailEnabled: true }),
    resolveRecipient: vi.fn().mockReturnValue({ email: "owner@example.com" }),
    runScan: vi.fn(async (installation) => scanResultFor(Number(installation.authorizedAppId.split("-")[1]))),
    sendEmail: vi.fn().mockResolvedValue(undefined),
    hasAlertFeature: vi.fn().mockResolvedValue(true),
    readAlertState: vi.fn().mockResolvedValue({ state: {} }),
    writeAlertState: vi.fn().mockResolvedValue(undefined),
    deliverAlerts: vi.fn().mockResolvedValue({ status: "skipped", reason: "no_events" }),
    canonicalOrigin: () => "https://health.example.com",
    now: () => NOW,
    createRunOwnerId: () => "run-owner",
    candidateBatchSize: 50,
    maxScans: 6,
    concurrency: 3,
    ...overrides,
  };
}

describe("daily monitoring scheduler", () => {
  it("runs Pro monitoring independently from optional email delivery", async () => {
    const dependencies = fixture({
      resolveMonitoring: vi.fn(async (installation) => {
        if (installation.authorizedAppId === "app-1") return undefined;
        if (installation.authorizedAppId === "app-2") return { lowStockThreshold: 4, dailyEmailEnabled: false };
        return { lowStockThreshold: 7, dailyEmailEnabled: true };
      }),
      resolveRecipient: vi.fn((tenant) => tenant.authorizedAppId === "app-3" ? undefined : { email: "owner@example.com" }),
    });

    const result = await runDailyMonitoring(dependencies);

    expect(dependencies.claimIfDue).toHaveBeenCalledWith(
      expect.objectContaining({ authorizedAppId: "app-2" }),
      "run-owner",
      NOW.getTime(),
      23 * 60 * 60 * 1000,
      20 * 60 * 1000,
    );
    expect(dependencies.claimIfDue).toHaveBeenCalledTimes(6);
    expect(dependencies.runScan).toHaveBeenCalledTimes(6);
    expect(dependencies.sendEmail).toHaveBeenCalledTimes(4);
    expect(dependencies.sendEmail).toHaveBeenCalledWith(
      { email: "owner@example.com" },
      expect.any(Object),
      "ikas-monitoring/delivery-window-1",
    );
    expect(dependencies.completeRun).toHaveBeenCalledTimes(6);
    expect(dependencies.releaseRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      inspected: 7,
      claimed: 6,
      scheduled: 6,
      completed: 6,
      sent: 4,
      emailSkipped: 2,
      emailFailed: 0,
      alertsSent: 0,
      alertsSkipped: 6,
      alertsFailed: 0,
      busy: 0,
      failed: 0,
    });
  });

  it("caps work and concurrency without leaking tenant details in the result", async () => {
    let active = 0;
    let maximum = 0;
    const runScan = vi.fn(async (installation: (typeof installations)[number]) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return scanResultFor(Number(installation.authorizedAppId.split("-")[1]));
    });
    const dependencies = fixture({ runScan, maxScans: 6, concurrency: 3 });

    const result = await runDailyMonitoring(dependencies);

    expect(runScan).toHaveBeenCalledTimes(6);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(JSON.stringify(result)).not.toContain("merchant-");
    expect(JSON.stringify(result)).not.toContain("owner@");
  });

  it("releases busy and failed runs so another hourly invocation can retry", async () => {
    const runScan = vi.fn(async (installation: (typeof installations)[number]) => {
      if (installation.authorizedAppId === "app-1") {
        const error = new Error("IKAS_SCAN_ALREADY_RUNNING");
        error.name = "ScanBusyError";
        throw error;
      }
      if (installation.authorizedAppId === "app-2") throw new Error("private tenant failure");
      return scanResultFor(Number(installation.authorizedAppId.split("-")[1]));
    });
    const dependencies = fixture({ runScan, maxScans: 4 });

    const result = await runDailyMonitoring(dependencies);

    expect(result).toEqual({
      inspected: 4,
      claimed: 4,
      scheduled: 4,
      completed: 2,
      sent: 2,
      emailSkipped: 0,
      emailFailed: 0,
      alertsSent: 0,
      alertsSkipped: 2,
      alertsFailed: 0,
      busy: 1,
      failed: 1,
    });
    expect(dependencies.completeRun).toHaveBeenCalledTimes(2);
    expect(dependencies.releaseRun).toHaveBeenCalledTimes(2);
  });

  it("commits a successful scan cadence even when optional email delivery fails", async () => {
    const installation = installations[0]!;
    const dependencies = fixture({
      listInstallations: vi.fn().mockResolvedValue([installation]),
      sendEmail: vi.fn().mockRejectedValue(new Error("private provider failure")),
    });

    const result = await runDailyMonitoring(dependencies);

    expect(dependencies.runScan).toHaveBeenCalledOnce();
    expect(dependencies.completeRun).toHaveBeenCalledOnce();
    expect(dependencies.releaseRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ completed: 1, sent: 0, emailFailed: 1, failed: 0 });
    expect(JSON.stringify(result)).not.toContain("private provider failure");
  });

  it("reuses the same provider idempotency key when email succeeds but completion must retry", async () => {
    const installation = installations[0]!;
    const firstClaim = claimFor(installation, "owner-first");
    const retryClaim = { ...firstClaim, ownerId: "owner-retry" };
    const sendEmail = vi.fn<DailyMonitoringDependencies["sendEmail"]>().mockResolvedValue(undefined);
    const dependencies = fixture({
      listInstallations: vi.fn().mockResolvedValue([installation]),
      claimIfDue: vi.fn().mockResolvedValueOnce(firstClaim).mockResolvedValueOnce(retryClaim),
      completeRun: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      sendEmail,
    });

    const first = await runDailyMonitoring(dependencies);
    const retry = await runDailyMonitoring(dependencies);

    expect(first).toMatchObject({ completed: 0, sent: 0, failed: 1 });
    expect(retry).toMatchObject({ completed: 1, sent: 1, failed: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls.map((call) => call[2])).toEqual([
      "ikas-monitoring/delivery-window-1",
      "ikas-monitoring/delivery-window-1",
    ]);
  });

  it("covers the supported registry capacity within one day despite repeatedly failing early tenants", async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      authorizedAppId: `app-${index + 1}`,
      merchantId: `merchant-${index + 1}`,
      storeName: `store-${index + 1}`,
    }));
    let hour = 0;
    const scanned = new Set<string>();
    const dependencies = fixture({
      listInstallations: vi.fn().mockResolvedValue(many),
      now: () => new Date(NOW.getTime() + hour * 60 * 60 * 1000),
      candidateBatchSize: 50,
      maxScans: 6,
      runScan: vi.fn(async (installation) => {
        scanned.add(installation.authorizedAppId);
        return scanResultFor(Number(installation.authorizedAppId.split("-")[1]));
      }),
    });

    for (hour = 0; hour < 24; hour += 1) {
      await runDailyMonitoring(dependencies);
    }

    expect(scanned).toEqual(new Set(many.map((installation) => installation.authorizedAppId)));
  });

  it("does not scan when another invocation owns the due lease", async () => {
    const dependencies = fixture({ claimIfDue: vi.fn().mockResolvedValue(undefined) });

    const result = await runDailyMonitoring(dependencies);

    expect(dependencies.resolveMonitoring).toHaveBeenCalledTimes(8);
    expect(dependencies.runScan).not.toHaveBeenCalled();
    expect(result).toEqual({
      inspected: 8,
      claimed: 0,
      scheduled: 0,
      completed: 0,
      sent: 0,
      emailSkipped: 0,
      emailFailed: 0,
      alertsSent: 0,
      alertsSkipped: 0,
      alertsFailed: 0,
      busy: 0,
      failed: 0,
    });
  });
});

/**
 * Low-stock alerting rides on the scheduled scan rather than running as a second system, so these
 * cover the seam: the threshold decides what is low, the e-mail consent decides whether anything
 * is delivered, and the durable state is written either way.
 */
describe("low-stock alert delivery", () => {
  const observation = {
    productId: "product-1",
    productName: "Classic Laptop Sleeve",
    variantId: "variant-1",
    stockLocationId: "location-1",
    stockCount: 1,
  };

  function alertFixture(overrides: Partial<DailyMonitoringDependencies> = {}) {
    return fixture({
      listInstallations: vi.fn().mockResolvedValue([installations[0]]),
      runScan: vi.fn(async () => ({
        snapshot: snapshotFor(1),
        observationSet: { observations: [observation], truncated: false },
      })),
      ...overrides,
    });
  }

  it("delivers one grouped notification for a fresh crossing", async () => {
    const dependencies = alertFixture({
      deliverAlerts: vi.fn().mockResolvedValue({ status: "sent" }),
    });

    const result = await runDailyMonitoring(dependencies);

    expect(result.alertsSent).toBe(1);
    expect(dependencies.deliverAlerts).toHaveBeenCalledWith(
      installations[0],
      { email: "owner@example.com" },
      [expect.objectContaining({ kind: "crossing", stockCount: 1 })],
      "scan-1",
      "store-1",
    );
    expect(dependencies.writeAlertState).toHaveBeenCalledWith(
      installations[0],
      expect.objectContaining({ lastScanId: "scan-1" }),
    );
  });

  it("records the crossing but sends nothing when the merchant never enabled e-mail", async () => {
    const dependencies = alertFixture({
      resolveMonitoring: vi.fn().mockResolvedValue({ lowStockThreshold: 7, dailyEmailEnabled: false }),
      deliverAlerts: vi.fn(),
    });

    const result = await runDailyMonitoring(dependencies);

    expect(result.alertsSkipped).toBe(1);
    expect(dependencies.deliverAlerts).not.toHaveBeenCalled();
    expect(dependencies.writeAlertState).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no threshold is configured", async () => {
    const dependencies = alertFixture({
      resolveMonitoring: vi.fn().mockResolvedValue({ lowStockThreshold: 0, dailyEmailEnabled: true }),
      deliverAlerts: vi.fn(),
    });

    const result = await runDailyMonitoring(dependencies);

    expect(result.alertsSkipped).toBe(1);
    expect(dependencies.readAlertState).not.toHaveBeenCalled();
    expect(dependencies.deliverAlerts).not.toHaveBeenCalled();
  });

  it("stays silent when the same scan is evaluated twice", async () => {
    const dependencies = alertFixture({
      readAlertState: vi.fn().mockResolvedValue({ state: {}, lastScanId: "scan-1" }),
      deliverAlerts: vi.fn(),
    });

    const result = await runDailyMonitoring(dependencies);

    expect(result.alertsSkipped).toBe(1);
    expect(dependencies.writeAlertState).not.toHaveBeenCalled();
    expect(dependencies.deliverAlerts).not.toHaveBeenCalled();
  });

  it("keeps the scan successful when the alert state store is unavailable", async () => {
    const dependencies = alertFixture({
      readAlertState: vi.fn().mockRejectedValue(new Error("redis down")),
    });

    const result = await runDailyMonitoring(dependencies);

    expect(result.completed).toBe(1);
    expect(result.alertsFailed).toBe(1);
    expect(result.failed).toBe(0);
  });
});
