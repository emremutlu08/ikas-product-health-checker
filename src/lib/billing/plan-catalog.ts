/**
 * Proposed Partner-panel key for the first Pro listing. It is intentionally centralized here
 * and must be two-person verified against the saved panel value before any production wiring.
 * ikas listing subscription keys are immutable once saved in the Partner panel, so the
 * app never spreads a raw key through feature checks. Everything downstream reasons about
 * the semantic tier instead, which lets a future price or package key map onto the same tier.
 */
export type SemanticTier = "free" | "pro";

export const PRO_PLAN_KEY = "product-health-pro-try-v1";

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
