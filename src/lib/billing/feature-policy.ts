import type { SemanticTier } from "./plan-catalog";

/**
 * The single place that decides what a tier may do. Routes, jobs and UI ask for a feature,
 * never for a plan key or a tier string, so adding a plan key cannot silently widen access.
 */
export const APP_FEATURES = [
  "manual-scan",
  "csv-export",
  "scheduled-scan",
  "scan-history",
  "low-stock-threshold-config",
  "daily-email-summary",
] as const;

export type AppFeature = (typeof APP_FEATURES)[number];

/** Minimum tier required per feature. Manual scan and CSV export stay Free, as shipped today. */
const FEATURE_MINIMUM_TIER = new Map<AppFeature, SemanticTier>([
  ["manual-scan", "free"],
  ["csv-export", "free"],
  ["scheduled-scan", "pro"],
  ["scan-history", "pro"],
  ["low-stock-threshold-config", "pro"],
  ["daily-email-summary", "pro"],
]);

const TIER_RANK = new Map<SemanticTier, number>([
  ["free", 0],
  ["pro", 1],
]);

/** Fail-closed: an unrecognised feature or tier is denied rather than defaulted upward. */
export function isFeatureEnabled(feature: AppFeature, tier: SemanticTier): boolean {
  const required = FEATURE_MINIMUM_TIER.get(feature);
  if (required === undefined) return false;

  const grantedRank = TIER_RANK.get(tier);
  if (grantedRank === undefined) return false;

  const requiredRank = TIER_RANK.get(required);
  if (requiredRank === undefined) return false;

  return grantedRank >= requiredRank;
}

export function listEnabledFeatures(tier: SemanticTier): AppFeature[] {
  return APP_FEATURES.filter((feature) => isFeatureEnabled(feature, tier));
}
