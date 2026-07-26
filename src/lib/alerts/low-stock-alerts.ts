import type { StockObservation, StockObservationSet } from "./stock-observation";

/**
 * Deciding what is worth telling a merchant about their stock.
 *
 * This is a pure function of "what the scan saw" and "what we last told them", which is what makes
 * the awkward parts tractable: a repeated scan produces no second notification, a variant that sits
 * below the threshold for a week produces one, and a variant that recovers produces exactly one
 * recovery notice. Nothing here sends anything or reads a clock of its own.
 */

export type AlertSide = "below" | "above";

export type AlertEntryState = {
  side: AlertSide;
  firstSeen: number;
  lastSeen: number;
  lastNotifiedAt?: number;
  lastNotifiedSide?: AlertSide;
};

export type AlertStateMap = Record<string, AlertEntryState>;

export type LowStockAlertEvent = {
  kind: "crossing" | "recovery";
  entryKey: string;
  productId: string;
  productName: string;
  variantId: string;
  variantLabel?: string;
  stockLocationId: string;
  stockCount: number;
  threshold: number;
};

export type LowStockEvaluation = {
  events: LowStockAlertEvent[];
  nextState: AlertStateMap;
  /** Set when the projection was truncated or the threshold is off; no state is written then. */
  skipped?: "truncated_observation" | "threshold_disabled" | "duplicate_scan";
};

export const DEFAULT_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
/** How long a recovered entry is remembered, so a flapping variant cannot re-alert immediately. */
export const RECOVERED_ENTRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A tracked entry the scan stops reporting is dropped rather than treated as a recovery. */
export const MISSING_ENTRY_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_TRACKED_ENTRIES = 500;

export function entryKeyFor(observation: Pick<StockObservation, "productId" | "variantId" | "stockLocationId">) {
  return `${observation.productId}|${observation.variantId}|${observation.stockLocationId}`;
}

export type LowStockEvaluationInput = {
  observationSet: StockObservationSet;
  previousState: AlertStateMap;
  threshold: number;
  now: number;
  cooldownMs?: number;
  /** Identifier of the scan being evaluated; a repeat of the same scan is a no-op. */
  scanId: string;
  lastEvaluatedScanId?: string;
};

function eventFor(
  kind: LowStockAlertEvent["kind"],
  observation: StockObservation,
  threshold: number,
): LowStockAlertEvent {
  return {
    kind,
    entryKey: entryKeyFor(observation),
    productId: observation.productId,
    productName: observation.productName,
    variantId: observation.variantId,
    ...(observation.variantLabel ? { variantLabel: observation.variantLabel } : {}),
    stockLocationId: observation.stockLocationId,
    stockCount: observation.stockCount,
    threshold,
  };
}

function withinCooldown(state: AlertEntryState | undefined, now: number, cooldownMs: number) {
  return state?.lastNotifiedAt !== undefined && now - state.lastNotifiedAt < cooldownMs;
}

export function evaluateLowStockAlerts({
  observationSet,
  previousState,
  threshold,
  now,
  cooldownMs = DEFAULT_ALERT_COOLDOWN_MS,
  scanId,
  lastEvaluatedScanId,
}: LowStockEvaluationInput): LowStockEvaluation {
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    return { events: [], nextState: {}, skipped: "threshold_disabled" };
  }
  if (lastEvaluatedScanId === scanId) {
    return { events: [], nextState: previousState, skipped: "duplicate_scan" };
  }
  // A truncated projection cannot distinguish "recovered" from "not in the sample", so the whole
  // evaluation is skipped rather than risking a wrong recovery notice.
  if (observationSet.truncated) {
    return { events: [], nextState: previousState, skipped: "truncated_observation" };
  }

  const events: LowStockAlertEvent[] = [];
  const nextState: AlertStateMap = {};
  const seen = new Set<string>();

  for (const observation of observationSet.observations) {
    const key = entryKeyFor(observation);
    // A duplicated key inside one scan is counted once; the first row wins.
    if (seen.has(key)) continue;
    seen.add(key);

    const previous = previousState[key];
    const below = observation.stockCount <= threshold;

    if (below) {
      const alreadyBelow = previous?.side === "below";
      const suppressed = withinCooldown(previous, now, cooldownMs);
      /**
       * The test is "have we already told them about *this* dip", not "is it still below". A
       * crossing the cooldown suppressed therefore stays pending and is reported once the window
       * closes, rather than being swallowed because the variant never came back up in between.
       */
      const notify = !suppressed && previous?.lastNotifiedSide !== "below";
      if (notify) events.push(eventFor("crossing", observation, threshold));

      nextState[key] = {
        side: "below",
        firstSeen: alreadyBelow ? previous.firstSeen : now,
        lastSeen: now,
        ...(notify
          ? { lastNotifiedAt: now, lastNotifiedSide: "below" as const }
          : previous?.lastNotifiedAt !== undefined
            ? { lastNotifiedAt: previous.lastNotifiedAt, lastNotifiedSide: previous.lastNotifiedSide }
            : {}),
      };
      continue;
    }

    if (!previous) continue;

    if (previous.side === "below") {
      // Recovery is only worth reporting when the merchant was told about the crossing.
      const notify = previous.lastNotifiedSide === "below";
      if (notify) events.push(eventFor("recovery", observation, threshold));
      nextState[key] = {
        side: "above",
        firstSeen: previous.firstSeen,
        lastSeen: now,
        ...(notify
          ? { lastNotifiedAt: now, lastNotifiedSide: "above" as const }
          : previous.lastNotifiedAt !== undefined
            ? { lastNotifiedAt: previous.lastNotifiedAt, lastNotifiedSide: previous.lastNotifiedSide }
            : {}),
      };
      continue;
    }

    // Still above: remembered only long enough to keep a flapping variant inside its cooldown.
    if (now - previous.lastSeen <= RECOVERED_ENTRY_RETENTION_MS) {
      nextState[key] = { ...previous, lastSeen: now };
    }
  }

  for (const [key, previous] of Object.entries(previousState)) {
    if (seen.has(key)) continue;
    // Absent from this scan: the variant or location may simply be gone, so it is retained
    // briefly and then dropped. It is never reported as a recovery.
    if (now - previous.lastSeen <= MISSING_ENTRY_RETENTION_MS) nextState[key] = previous;
  }

  return { events, nextState: boundState(nextState) };
}

/**
 * Keeps the durable record finite. Entries currently below the threshold are the ones a merchant
 * still needs, so they are kept first and the oldest recovered entries fall off.
 */
function boundState(state: AlertStateMap): AlertStateMap {
  const entries = Object.entries(state);
  if (entries.length <= MAX_TRACKED_ENTRIES) return state;

  entries.sort(([, left], [, right]) => {
    if (left.side !== right.side) return left.side === "below" ? -1 : 1;
    return right.lastSeen - left.lastSeen;
  });
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_ENTRIES));
}

/** Stable across retries of the same scan, distinct across scans and across sides. */
export function alertIdempotencyKey(scanId: string, event: LowStockAlertEvent) {
  return `alert/${scanId}/${event.kind}/${event.productId}.${event.variantId}.${event.stockLocationId}`;
}
