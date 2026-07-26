/**
 * The Partner-panel key for the first Pro listing, as saved in the panel on 2026-07-27 under the
 * configuration name "Product Health PRO".
 *
 * ikas derives this key from that name and then freezes it — the panel states it cannot be changed
 * after saving — which is exactly why the app never spreads a raw key through feature checks.
 * Everything downstream reasons about the semantic tier instead, so a later price change, an extra
 * package, or a second region can map onto the same tier without touching authorization.
 */
export type SemanticTier = "free" | "pro";

export const PRO_PLAN_KEY = "productHealthPro";

/** Map, not an object literal, so keys like `__proto__` cannot resolve through the prototype. */
const PLAN_KEY_TO_TIER = new Map<string, SemanticTier>([[PRO_PLAN_KEY, "pro"]]);

export type PlanKeyResolution =
  | { known: true; planKey: string; tier: SemanticTier }
  | { known: false };

/**
 * Default-deny: an unknown, malformed, or non-string key never resolves to a tier. Callers
 * must treat `known: false` as "no paid entitlement", never as a plain Free subscription.
 */
export function resolvePlanKey(planKey: unknown): PlanKeyResolution {
  if (typeof planKey !== "string") return { known: false };

  const tier = PLAN_KEY_TO_TIER.get(planKey);
  if (!tier) return { known: false };

  return { known: true, planKey, tier };
}
