import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_COOLDOWN_MS, evaluateLowStockAlerts, entryKeyFor, type AlertStateMap } from "@/lib/alerts/low-stock-alerts";

const NOW = 1_753_000_000_000;
const obs = (stockCount: number) => ({
  productId: "p1", productName: "P", variantId: "v1", stockLocationId: "l1", stockCount,
});
const key = entryKeyFor(obs(0));

function ev(observations: ReturnType<typeof obs>[], previousState: AlertStateMap, now: number, scanId: string) {
  return evaluateLowStockAlerts({
    observationSet: { observations, truncated: false },
    previousState, threshold: 5, now, scanId,
  });
}

describe("sequential cooldown", () => {
  it("permanently loses a crossing after a suppressed one", () => {
    // scan1: below -> crossing notified
    const s1 = ev([obs(2)], {}, NOW, "s1");
    expect(s1.events.map(e => e.kind)).toEqual(["crossing"]);
    // scan2: recovered -> recovery notified (lastNotifiedAt = NOW+1h, side above)
    const s2 = ev([obs(50)], s1.nextState, NOW + 3_600_000, "s2");
    expect(s2.events.map(e => e.kind)).toEqual(["recovery"]);
    // scan3: drops below again, inside cooldown -> suppressed
    const s3 = ev([obs(1)], s2.nextState, NOW + 7_200_000, "s3");
    expect(s3.events).toEqual([]);
    console.log("s3 state", s3.nextState[key]);
    // scan4..: long after the cooldown expired, still below
    const s4 = ev([obs(1)], s3.nextState, NOW + 7_200_000 + DEFAULT_ALERT_COOLDOWN_MS + 1, "s4");
    console.log("s4 events", s4.events);
    const s5 = ev([obs(1)], s4.nextState, NOW + 10 * DEFAULT_ALERT_COOLDOWN_MS, "s5");
    console.log("s5 events", s5.events);
    expect(s4.events).toEqual([]); // BUG: merchant never told
    expect(s5.events).toEqual([]);
  });
});
