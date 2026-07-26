import { getCanonicalAppOrigin } from "@/helpers/api-helpers";
import { isInstallationFeatureEnabled } from "@/lib/billing/runtime-entitlement";
import { assessHealth } from "@/lib/health/health-model";
import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import {
  listRegisteredInstallations,
  type InstallationRegistryRecord,
} from "@/lib/registry/installation-registry-store";
import { runScheduledScan, ScanBusyError, type ScanExecutionResult } from "@/lib/scans/scan-service";
import type { ScanSnapshot } from "@/lib/scans/snapshot-store";
import {
  deliverLowStockAlerts,
  type AlertDeliveryOutcome,
} from "@/lib/alerts/alert-notifier";
import {
  alertOutboxStore,
  lowStockAlertStore,
  type AlertStateRecord,
} from "@/lib/alerts/alert-store";
import { applyNotified, evaluateLowStockAlerts } from "@/lib/alerts/low-stock-alerts";
import { readMonitoringSettings, SettingsAccessError } from "@/lib/settings/settings-service";
import type { MonitoringSettings } from "@/lib/settings/settings-store";
import {
  createDailySummaryEmailSender,
  createTransactionalEmailSender,
  type DailyEmailSummary,
} from "./email-summary";
import {
  claimMonitoringRunIfDue,
  completeMonitoringRun,
  releaseMonitoringRun,
  type MonitoringRunClaim,
} from "./schedule-store";
import { resolveVerifiedRecipient, type VerifiedRecipient } from "./verified-recipient";

export const MONITORING_INTERVAL_MS = 23 * 60 * 60 * 1000;
export const DEFAULT_CANDIDATE_BATCH_SIZE = 50;
export const DEFAULT_MAX_SCANS = 6;
export const DEFAULT_CONCURRENCY = 3;
export const MONITORING_RUN_LEASE_TTL_MS = 20 * 60 * 1000;

export type DailyMonitoringResult = {
  inspected: number;
  claimed: number;
  scheduled: number;
  completed: number;
  sent: number;
  emailSkipped: number;
  emailFailed: number;
  /** Scans that produced at least one crossing or recovery notification. */
  alertsSent: number;
  alertsSkipped: number;
  alertsFailed: number;
  busy: number;
  failed: number;
};

export type DailyMonitoringDependencies = {
  listInstallations(): Promise<InstallationRegistryRecord[]>;
  claimIfDue(
    tenant: InstallationIdentity,
    ownerId: string,
    attemptedAtMs: number,
    minimumIntervalMs: number,
    leaseTtlMs: number,
  ): Promise<MonitoringRunClaim | undefined>;
  completeRun(claim: MonitoringRunClaim, completedAtMs: number): Promise<boolean>;
  releaseRun(claim: MonitoringRunClaim): Promise<boolean>;
  resolveMonitoring(installation: InstallationIdentity): Promise<MonitoringSettings | undefined>;
  resolveRecipient(installation: InstallationIdentity): VerifiedRecipient | undefined;
  runScan(
    installation: InstallationIdentity,
    policy: { retention: { historyEnabled: true }; lowStockThreshold: number },
  ): Promise<ScanExecutionResult>;
  sendEmail(recipient: VerifiedRecipient, summary: DailyEmailSummary, idempotencyKey: string): Promise<void>;
  /** The grant the plan surface advertises for alerts, enforced before anything is delivered. */
  hasAlertFeature(installation: InstallationIdentity): Promise<boolean>;
  readAlertState(tenant: InstallationIdentity): Promise<AlertStateRecord>;
  writeAlertState(tenant: InstallationIdentity, record: AlertStateRecord): Promise<void>;
  deliverAlerts(
    tenant: InstallationIdentity,
    recipient: VerifiedRecipient,
    events: Parameters<typeof deliverLowStockAlerts>[2],
    scanId: string,
    storeName: string,
  ): Promise<AlertDeliveryOutcome>;
  canonicalOrigin(): string;
  now(): Date;
  createRunOwnerId(): string;
  candidateBatchSize?: number;
  maxScans?: number;
  concurrency?: number;
};

let emailSender: ReturnType<typeof createDailySummaryEmailSender> | undefined;
let alertSender: ReturnType<typeof createTransactionalEmailSender> | undefined;

const defaultDependencies: DailyMonitoringDependencies = {
  listInstallations: listRegisteredInstallations,
  claimIfDue: claimMonitoringRunIfDue,
  completeRun: completeMonitoringRun,
  releaseRun: releaseMonitoringRun,
  async resolveMonitoring(installation) {
    try {
      return (await readMonitoringSettings(installation)).settings;
    } catch (error) {
      if (error instanceof SettingsAccessError) return undefined;
      throw error;
    }
  },
  resolveRecipient: resolveVerifiedRecipient,
  runScan: (installation, policy) => runScheduledScan(installation, policy),
  sendEmail: (recipient, summary, idempotencyKey) => {
    emailSender ??= createDailySummaryEmailSender();
    return emailSender.send(recipient, summary, idempotencyKey);
  },
  canonicalOrigin: getCanonicalAppOrigin,
  now: () => new Date(),
  createRunOwnerId: () => crypto.randomUUID(),
  hasAlertFeature: (installation) => isInstallationFeatureEnabled(installation, "low-stock-alerts"),
  readAlertState: (tenant) => lowStockAlertStore().read(tenant),
  writeAlertState: (tenant, record) => lowStockAlertStore().write(tenant, record),
  deliverAlerts: (tenant, recipient, events, scanId, storeName) => {
    alertSender ??= createTransactionalEmailSender();
    return deliverLowStockAlerts(tenant, recipient, events, scanId, storeName, {
      outbox: alertOutboxStore(),
      sender: alertSender,
      now: () => Date.now(),
    });
  },
};

function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("IKAS_MONITORING_LIMIT_INVALID");
  }
  return value;
}

function candidateWindow(
  installations: InstallationRegistryRecord[],
  nowMs: number,
  batchSize: number,
  stride: number,
): InstallationRegistryRecord[] {
  if (installations.length <= batchSize) return installations;
  const start = (Math.floor(nowMs / (60 * 60 * 1000)) * stride) % installations.length;
  return Array.from({ length: batchSize }, (_, index) => installations[(start + index) % installations.length]!);
}

function summaryFor(snapshot: ScanSnapshot, canonicalOrigin: string): DailyEmailSummary {
  const health = assessHealth(snapshot.report);
  return {
    generatedAt: snapshot.generatedAt,
    score: health.score,
    state: health.state,
    productCount: snapshot.report.productCount,
    issueCount: snapshot.report.issueCount,
    lowStockCount: snapshot.report.issueCountsByCode.low_stock,
    historyUrl: new URL("/history", canonicalOrigin).toString(),
  };
}

/**
 * Threshold state is kept even when nothing can be delivered, so the first message after a
 * merchant enables e-mail describes a real change rather than replaying their whole backlog.
 * A store failure here never fails the scan: the report is already durable.
 *
 * The "we told them" stamp is written only after a delivery succeeds. Writing it up-front would
 * make a failed e-mail look identical to a delivered one, and because each scan has its own
 * idempotency key the outbox would never get a second chance either — the crossing would simply
 * be lost.
 */
async function evaluateAndDeliverAlerts(
  installation: InstallationIdentity,
  recipient: VerifiedRecipient | undefined,
  threshold: number,
  scanId: string,
  observationSet: Awaited<ReturnType<DailyMonitoringDependencies["runScan"]>>["observationSet"],
  dependencies: DailyMonitoringDependencies,
): Promise<"sent" | "failed" | "skipped"> {
  if (threshold <= 0) return "skipped";

  try {
    const previous = await dependencies.readAlertState(installation);
    const evaluation = evaluateLowStockAlerts({
      observationSet,
      previousState: previous.state,
      threshold,
      now: dependencies.now().getTime(),
      scanId,
      ...(previous.lastScanId ? { lastEvaluatedScanId: previous.lastScanId } : {}),
    });
    if (evaluation.skipped) {
      if (evaluation.skipped === "truncated_observation") {
        // Silence here would look identical to "nothing was low", so an operator gets a signal.
        console.warn(
          JSON.stringify({ event: "ikas_low_stock_alerts_skipped", reason: evaluation.skipped }),
        );
      }
      return "skipped";
    }

    const deliverable =
      Boolean(recipient) &&
      evaluation.events.length > 0 &&
      // Resolved only when there is something to send, so a quiet scan pays for no licence read.
      (await dependencies.hasAlertFeature(installation));

    if (!deliverable) {
      await dependencies.writeAlertState(installation, {
        state: evaluation.nextState,
        lastScanId: scanId,
      });
      return "skipped";
    }

    const outcome = await dependencies.deliverAlerts(
      installation,
      recipient!,
      evaluation.events,
      scanId,
      installation.storeName,
    );
    await dependencies.writeAlertState(installation, {
      state:
        outcome.status === "sent"
          ? applyNotified(evaluation.nextState, evaluation.events, dependencies.now().getTime())
          : evaluation.nextState,
      lastScanId: scanId,
    });
    return outcome.status === "sent" ? "sent" : outcome.status === "failed" ? "failed" : "skipped";
  } catch {
    return "failed";
  }
}

export async function runDailyMonitoring(
  dependencies: DailyMonitoringDependencies = defaultDependencies,
): Promise<DailyMonitoringResult> {
  const candidateBatchSize = boundedInteger(dependencies.candidateBatchSize, DEFAULT_CANDIDATE_BATCH_SIZE, 100);
  const maxScans = boundedInteger(dependencies.maxScans, DEFAULT_MAX_SCANS, 20);
  const concurrency = boundedInteger(dependencies.concurrency, DEFAULT_CONCURRENCY, 10);
  if (concurrency > maxScans) throw new Error("IKAS_MONITORING_LIMIT_INVALID");

  const now = dependencies.now();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("IKAS_MONITORING_CLOCK_INVALID");
  const candidates = candidateWindow(
    await dependencies.listInstallations(),
    nowMs,
    candidateBatchSize,
    maxScans,
  );
  const result: DailyMonitoringResult = {
    inspected: 0,
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
  };
  const selected: Array<{
    installation: InstallationIdentity;
    recipient?: VerifiedRecipient;
    settings: MonitoringSettings;
    claim: MonitoringRunClaim;
  }> = [];

  for (const installation of candidates) {
    if (selected.length >= maxScans) break;
    result.inspected += 1;
    try {
      const settings = await dependencies.resolveMonitoring(installation);
      if (!settings) continue;
      // One consent covers both messages: a merchant who never turned e-mail on is not mailed
      // just because they configured a threshold.
      const recipient = settings.dailyEmailEnabled
        ? dependencies.resolveRecipient(installation)
        : undefined;
      const claim = await dependencies.claimIfDue(
        installation,
        dependencies.createRunOwnerId(),
        nowMs,
        MONITORING_INTERVAL_MS,
        MONITORING_RUN_LEASE_TTL_MS,
      );
      if (!claim) continue;
      result.claimed += 1;
      selected.push({ installation, ...(recipient ? { recipient } : {}), settings, claim });
    } catch {
      result.failed += 1;
    }
  }

  result.scheduled = selected.length;
  for (let offset = 0; offset < selected.length; offset += concurrency) {
    const chunk = selected.slice(offset, offset + concurrency);
    await Promise.all(
      chunk.map(async ({ installation, recipient, settings, claim }) => {
        try {
          const { snapshot, observationSet } = await dependencies.runScan(installation, {
            retention: { historyEnabled: true },
            lowStockThreshold: settings.lowStockThreshold,
          });

          const alertOutcome = await evaluateAndDeliverAlerts(
            installation,
            recipient,
            settings.lowStockThreshold,
            snapshot.scanId,
            observationSet,
            dependencies,
          );
          if (alertOutcome === "sent") result.alertsSent += 1;
          else if (alertOutcome === "failed") result.alertsFailed += 1;
          else result.alertsSkipped += 1;

          let emailDelivered = false;
          let emailDeliveryFailed = false;
          if (settings.dailyEmailEnabled && recipient) {
            try {
              await dependencies.sendEmail(
                recipient,
                summaryFor(snapshot, dependencies.canonicalOrigin()),
                `ikas-monitoring/${claim.deliveryId}`,
              );
              emailDelivered = true;
            } catch {
              emailDeliveryFailed = true;
            }
          }
          const completed = await dependencies.completeRun(claim, dependencies.now().getTime());
          if (!completed) throw new Error("IKAS_MONITORING_RUN_OWNERSHIP_LOST");
          result.completed += 1;
          if (emailDelivered) result.sent += 1;
          else if (emailDeliveryFailed) result.emailFailed += 1;
          else result.emailSkipped += 1;
        } catch (error) {
          await dependencies.releaseRun(claim).catch(() => false);
          if (error instanceof ScanBusyError || (error instanceof Error && error.name === "ScanBusyError")) {
            result.busy += 1;
          } else {
            result.failed += 1;
          }
        }
      }),
    );
  }

  return result;
}
