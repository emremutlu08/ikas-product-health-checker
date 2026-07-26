/**
 * The Partner-panel keys for the Pro listings, as saved in the panel on 2026-07-27.
 *
 * ikas derives each key from the listing's configuration name and then freezes it — the panel
 * states it cannot be changed after saving — which is exactly why the app never spreads a raw key
 * through feature checks. Everything downstream reasons about the semantic tier instead.
 *
 * There is one listing per currency because ikas prices per region, but they are the same product:
 * a merchant paying in euros buys the identical capability set as one paying in lira. So all three
 * map to `pro`. Leaving a region's key out of this map would not degrade gracefully — `resolvePlanKey`
 * default-denies, so a paying merchant in that region would be treated as having no entitlement at all.
 */
export type SemanticTier = "free" | "pro";

/** Türkiye / TRY. Kept as a named export because it is the listing the app was first built against. */
export const PRO_PLAN_KEY = "productHealthPro";
/** Europe / EUR. */
export const PRO_PLAN_KEY_EU = "productHealthProeu";
/** United States / USD. */
export const PRO_PLAN_KEY_US = "productHealthProus";

export const PRO_PLAN_KEYS = [PRO_PLAN_KEY, PRO_PLAN_KEY_EU, PRO_PLAN_KEY_US] as const;

/** Map, not an object literal, so keys like `__proto__` cannot resolve through the prototype. */
const PLAN_KEY_TO_TIER = new Map<string, SemanticTier>(
  PRO_PLAN_KEYS.map((key) => [key, "pro"] as const),
);

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
