import { isDailySummaryEmailConfigured } from "@/lib/monitoring/email-summary";
import { resolveVerifiedRecipient } from "@/lib/monitoring/verified-recipient";
import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import {
  bulkWritesEnabled,
  productWritesEnabled,
} from "@/lib/mutations/correction-runtime";
import type { RolloutSignals } from "./capability-catalog";

/**
 * Reads the deployment's real rollout state. Every signal is an operator-owned server fact, so the
 * merchant-facing matrix can never claim a capability works because the code for it exists.
 */
export function resolveRolloutSignals(installation: InstallationIdentity): RolloutSignals {
  let verifiedRecipientConfigured = false;
  try {
    verifiedRecipientConfigured = Boolean(resolveVerifiedRecipient(installation));
  } catch {
    verifiedRecipientConfigured = false;
  }

  return {
    productWritesEnabled: productWritesEnabled(),
    bulkWritesEnabled: bulkWritesEnabled(),
    schedulerEnabled: process.env.IKAS_MONITORING_SCHEDULER_ENABLED?.trim() === "true",
    emailDeliveryConfigured: isDailySummaryEmailConfigured(),
    verifiedRecipientConfigured,
  };
}
