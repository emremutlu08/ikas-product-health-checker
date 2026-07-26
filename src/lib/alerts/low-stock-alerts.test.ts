import { describe, expect, it } from "vitest";
import {
  applyNotified,
  DEFAULT_ALERT_COOLDOWN_MS,
  MAX_TRACKED_ENTRIES,
  MISSING_ENTRY_RETENTION_MS,
  entryKeyFor,
  evaluateLowStockAlerts,
  type AlertStateMap,
} from "./low-stock-alerts";
import type { StockObservation } from "./stock-observation";

const NOW = 1_753_000_000_000;
const THRESHOLD = 5;

function observation(overrides: Partial<StockObservation> = {}): StockObservation {
  return {
    productId: "product-1",
    productName: "Classic Laptop Sleeve",
    variantId: "variant-1",
    stockLocationId: "location-1",
    stockCount: 2,
    ...overrides,
  };
}

function evaluate(
  observations: StockObservation[],
  previousState: AlertStateMap = {},
  {
    now = NOW,
    scanId = "scan-2",
    lastEvaluatedScanId,
    truncated = false,
    threshold = THRESHOLD,
  }: {
    now?: number;
    scanId?: string;
    lastEvaluatedScanId?: string;
    truncated?: boolean;
    threshold?: number;
  } = {},
) {
  return evaluateLowStockAlerts({
    observationSet: { observations, truncated },
    previousState,
    threshold,
    now,
    scanId,
    ...(lastEvaluatedScanId ? { lastEvaluatedScanId } : {}),
  });
}

const key = entryKeyFor(observation());

/**
 * Evaluate, then record that the notification was actually delivered. Every scenario below chains
 * through this rather than reusing a starting state, because the split between "decided to tell
 * them" and "told them" is the thing under test.
 */
function delivered(result: ReturnType<typeof evaluate>, now = NOW) {
  return applyNotified(result.nextState, result.events, now);
}

describe("evaluateLowStockAlerts", () => {
  it("reports a first crossing and remembers it", () => {
    const result = evaluate([observation()]);

    expect(result.events).toEqual([
      expect.objectContaining({ kind: "crossing", stockCount: 2, threshold: THRESHOLD }),
    ]);
    // Evaluation alone records no notification; only a successful delivery does.
    expect(result.nextState[key]).toMatchObject({ side: "below", firstSeen: NOW });
    expect(result.nextState[key]!.lastNotifiedAt).toBeUndefined();
    expect(delivered(result)[key]).toMatchObject({
      lastNotifiedAt: NOW,
      lastNotifiedSide: "below",
    });
  });

  it("re-reports a crossing whose notification failed to reach the merchant", () => {
    const first = evaluate([observation()]);
    expect(first.events).toHaveLength(1);

    // Delivery failed, so the state is written without the notified stamp.
    const retry = evaluate([observation()], first.nextState, {
      now: NOW + 60_000,
      scanId: "scan-3",
    });

    expect(retry.events).toEqual([expect.objectContaining({ kind: "crossing" })]);
  });

  it("does not repeat itself while the variant stays below the threshold", () => {
    const first = evaluate([observation()]);
    const second = evaluate([observation({ stockCount: 1 })], delivered(first), {
      now: NOW + 60_000,
      scanId: "scan-3",
    });

    expect(second.events).toEqual([]);
    // The original crossing time is kept so the merchant can see how long it has been low.
    expect(second.nextState[key]).toMatchObject({ side: "below", firstSeen: NOW, lastSeen: NOW + 60_000 });
  });

  it("treats a re-run of the same scan as a no-op", () => {
    const result = evaluate([observation()], {}, { scanId: "scan-9", lastEvaluatedScanId: "scan-9" });

    expect(result).toMatchObject({ events: [], skipped: "duplicate_scan" });
  });

  it("reports a recovery once, and only when the crossing was reported", () => {
    const crossed = evaluate([observation()]);
    const recovered = evaluate([observation({ stockCount: 11 })], delivered(crossed), {
      now: NOW + 60_000,
      scanId: "scan-3",
    });

    expect(recovered.events).toEqual([expect.objectContaining({ kind: "recovery", stockCount: 11 })]);
    expect(delivered(recovered, NOW + 60_000)[key]).toMatchObject({
      side: "above",
      lastNotifiedSide: "above",
    });

    const again = evaluate([observation({ stockCount: 11 })], delivered(recovered, NOW + 60_000), {
      now: NOW + 120_000,
      scanId: "scan-4",
    });
    expect(again.events).toEqual([]);
  });

  it("stays silent about a recovery the merchant was never warned about", () => {
    const suppressed: AlertStateMap = {
      [key]: { side: "below", firstSeen: NOW - 1_000, lastSeen: NOW - 1_000 },
    };

    const result = evaluate([observation({ stockCount: 20 })], suppressed, { scanId: "scan-3" });

    expect(result.events).toEqual([]);
    expect(result.nextState[key]).toMatchObject({ side: "above" });
  });

  it("suppresses a fresh crossing inside the cooldown window", () => {
    const recovered: AlertStateMap = {
      [key]: {
        side: "above",
        firstSeen: NOW - 10_000,
        lastSeen: NOW - 10_000,
        lastNotifiedAt: NOW - 1_000,
        lastNotifiedSide: "above",
      },
    };

    const inside = evaluate([observation()], recovered, { scanId: "scan-3" });
    expect(inside.events).toEqual([]);
    expect(inside.nextState[key]).toMatchObject({ side: "below" });

    const outside = evaluate([observation()], recovered, {
      now: NOW + DEFAULT_ALERT_COOLDOWN_MS,
      scanId: "scan-4",
    });
    expect(outside.events).toEqual([expect.objectContaining({ kind: "crossing" })]);
  });

  it("still reports a crossing the cooldown suppressed, once the window closes", () => {
    const recentlyRecovered: AlertStateMap = {
      [key]: {
        side: "above",
        firstSeen: NOW - 10_000,
        lastSeen: NOW - 10_000,
        lastNotifiedAt: NOW - 1_000,
        lastNotifiedSide: "above",
      },
    };

    const suppressed = evaluate([observation()], recentlyRecovered, { scanId: "scan-3" });
    expect(suppressed.events).toEqual([]);
    expect(suppressed.nextState[key]).toMatchObject({ side: "below", lastNotifiedSide: "above" });

    // The variant never came back up, so without this the merchant would never hear about it.
    const afterCooldown = evaluate([observation()], suppressed.nextState, {
      now: NOW + DEFAULT_ALERT_COOLDOWN_MS,
      scanId: "scan-4",
    });
    expect(afterCooldown.events).toEqual([expect.objectContaining({ kind: "crossing" })]);

    // And still only once, now that it has actually been delivered.
    expect(
      evaluate([observation()], delivered(afterCooldown, NOW + DEFAULT_ALERT_COOLDOWN_MS), {
        now: NOW + DEFAULT_ALERT_COOLDOWN_MS * 3,
        scanId: "scan-5",
      }).events,
    ).toEqual([]);
  });

  it("counts zero stock as below the threshold", () => {
    expect(evaluate([observation({ stockCount: 0 })]).events).toHaveLength(1);
  });

  it("treats the threshold value itself as below", () => {
    expect(evaluate([observation({ stockCount: THRESHOLD })]).events).toHaveLength(1);
    expect(evaluate([observation({ stockCount: THRESHOLD + 1 })]).events).toHaveLength(0);
  });

  it("does nothing at all when the merchant has no threshold configured", () => {
    expect(evaluate([observation()], {}, { threshold: 0 })).toMatchObject({
      events: [],
      skipped: "threshold_disabled",
    });
  });

  it("refuses to evaluate a truncated projection rather than inventing recoveries", () => {
    const crossed = evaluate([observation()]);

    const result = evaluate([], crossed.nextState, { truncated: true, scanId: "scan-3" });

    expect(result).toMatchObject({ events: [], skipped: "truncated_observation" });
    expect(result.nextState).toEqual(crossed.nextState);
  });

  it("never reports a vanished variant as a recovery, and forgets it after the retention window", () => {
    const crossed = evaluate([observation()]);

    const stillRetained = evaluate([], crossed.nextState, { now: NOW + 1_000, scanId: "scan-3" });
    expect(stillRetained.events).toEqual([]);
    expect(stillRetained.nextState[key]).toBeDefined();

    const forgotten = evaluate([], crossed.nextState, {
      now: NOW + MISSING_ENTRY_RETENTION_MS + 1,
      scanId: "scan-4",
    });
    expect(forgotten.nextState[key]).toBeUndefined();
  });

  it("keys state by product, variant and stock location", () => {
    const result = evaluate([
      observation(),
      observation({ stockLocationId: "location-2", stockCount: 1 }),
    ]);

    expect(result.events).toHaveLength(2);
    expect(Object.keys(result.nextState).sort()).toEqual([
      "product-1|variant-1|location-1",
      "product-1|variant-1|location-2",
    ]);
  });

  it("counts a duplicated row inside one scan only once", () => {
    const result = evaluate([observation(), observation({ stockCount: 1 })]);

    expect(result.events).toHaveLength(1);
    expect(Object.keys(result.nextState)).toHaveLength(1);
  });

  it("keeps the durable record finite, preferring variants that are still below", () => {
    const observations = Array.from({ length: MAX_TRACKED_ENTRIES + 50 }, (_, index) =>
      observation({ variantId: `variant-${index}`, stockCount: 1 }),
    );

    const result = evaluate(observations);

    expect(Object.keys(result.nextState)).toHaveLength(MAX_TRACKED_ENTRIES);
    expect(Object.values(result.nextState).every((entry) => entry.side === "below")).toBe(true);
  });

  it("does not re-notify a surviving entry after an overflow eviction", () => {
    const observations = Array.from({ length: MAX_TRACKED_ENTRIES + 50 }, (_, index) =>
      observation({ variantId: `variant-${index}`, stockCount: 1 }),
    );
    const first = evaluate(observations);
    const state = delivered(first);

    // Re-evaluated from the bounded state, not from the unbounded one the scan produced.
    const second = evaluate(observations, state, { now: NOW + 60_000, scanId: "scan-3" });

    // Only the entries eviction actually dropped may be reported again.
    expect(second.events.length).toBe(observations.length - MAX_TRACKED_ENTRIES);
    // And the ones that were kept are the ones the merchant was already told about.
    expect(
      Object.values(state).every((entry) => entry.lastNotifiedSide === "below"),
    ).toBe(true);
  });
});
