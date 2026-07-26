import type { TransactionalEmail, TransactionalEmailSender } from "@/lib/monitoring/email-summary";
import type { VerifiedRecipient } from "@/lib/monitoring/verified-recipient";
import type { TenantIdentity } from "@/lib/lifecycle/tenant-identity";
import type { AlertOutboxStore } from "./alert-store";
import type { LowStockAlertEvent } from "./low-stock-alerts";

/**
 * Turning evaluated alerts into at most one delivered message.
 *
 * A scan sends a single grouped notification rather than one message per variant: the merchant
 * gets a readable list, and the app makes one provider call it can guard properly. The outbox
 * decides whether that call may happen at all — a repeat run, a concurrent worker, an exhausted
 * retry budget and a backoff window all short-circuit before anything is sent.
 */

export const ALERT_DELIVERY_LEASE_MS = 2 * 60 * 1000;
export const ALERT_RETRY_BASE_BACKOFF_MS = 15 * 60 * 1000;
export const ALERT_RETRY_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const MAX_LISTED_ALERT_LINES = 20;

export type AlertDeliveryOutcome =
  | { status: "sent" }
  | { status: "skipped"; reason: "no_events" | "already_sent" | "in_flight" | "backoff" | "exhausted" }
  | { status: "failed" };

export type AlertDeliveryDependencies = {
  outbox: Pick<AlertOutboxStore, "claim" | "markSent" | "markFailed">;
  sender: TransactionalEmailSender;
  now(): number;
};

export function backoffFor(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(ALERT_RETRY_BASE_BACKOFF_MS * 2 ** exponent, ALERT_RETRY_MAX_BACKOFF_MS);
}

function describe(event: LowStockAlertEvent) {
  const variant = event.variantLabel ? ` (${event.variantLabel})` : "";
  return event.kind === "crossing"
    ? `- ${event.productName}${variant}: stok ${event.stockCount}, eşik ${event.threshold}`
    : `- ${event.productName}${variant}: stok ${event.stockCount}, eşiğin üzerine çıktı`;
}

/**
 * The message body. It names products and counts the merchant already owns, and carries no
 * identifier, token or catalog payload beyond what a merchant would read in their own admin.
 */
export function buildLowStockAlertEmail(
  events: readonly LowStockAlertEvent[],
  storeName: string,
): TransactionalEmail {
  const crossings = events.filter((event) => event.kind === "crossing");
  const recoveries = events.filter((event) => event.kind === "recovery");

  const lines: string[] = [`Ürün Sağlığı stok bildirimi — ${storeName}`, ""];
  if (crossings.length > 0) {
    lines.push(`Eşiğin altına düşen varyantlar (${crossings.length}):`);
    lines.push(...crossings.slice(0, MAX_LISTED_ALERT_LINES).map(describe));
    if (crossings.length > MAX_LISTED_ALERT_LINES) {
      lines.push(`- ve ${crossings.length - MAX_LISTED_ALERT_LINES} tane daha`);
    }
    lines.push("");
  }
  if (recoveries.length > 0) {
    lines.push(`Yeniden eşiğin üzerine çıkan varyantlar (${recoveries.length}):`);
    lines.push(...recoveries.slice(0, MAX_LISTED_ALERT_LINES).map(describe));
    if (recoveries.length > MAX_LISTED_ALERT_LINES) {
      lines.push(`- ve ${recoveries.length - MAX_LISTED_ALERT_LINES} tane daha`);
    }
    lines.push("");
  }
  lines.push("Bu bildirim yalnızca durum değiştiğinde gönderilir; stok verileriniz değiştirilmez.");

  return {
    subject: `Ürün Sağlığı stok bildirimi — ${storeName}`,
    text: lines.join("\n"),
  };
}

/** Stable for every retry of one scan, and distinct for the next one. */
export function scanAlertIdempotencyKey(scanId: string) {
  return `alert/${scanId}/low-stock`;
}

export async function deliverLowStockAlerts(
  tenant: TenantIdentity,
  recipient: VerifiedRecipient,
  events: readonly LowStockAlertEvent[],
  scanId: string,
  storeName: string,
  dependencies: AlertDeliveryDependencies,
): Promise<AlertDeliveryOutcome> {
  if (events.length === 0) return { status: "skipped", reason: "no_events" };

  const idempotencyKey = scanAlertIdempotencyKey(scanId);
  const claim = await dependencies.outbox.claim(
    tenant,
    idempotencyKey,
    dependencies.now(),
    ALERT_DELIVERY_LEASE_MS,
  );
  if (claim.outcome !== "claimed") return { status: "skipped", reason: claim.outcome };

  try {
    await dependencies.sender.send(
      recipient,
      buildLowStockAlertEmail(events, storeName),
      idempotencyKey,
    );
  } catch {
    // The provider may still have accepted it, which is exactly why the same idempotency key is
    // reused on the next attempt rather than a fresh one.
    await dependencies.outbox
      .markFailed(tenant, idempotencyKey, dependencies.now() + backoffFor(claim.attempts))
      .catch(() => undefined);
    return { status: "failed" };
  }

  await dependencies.outbox.markSent(tenant, idempotencyKey);
  return { status: "sent" };
}
