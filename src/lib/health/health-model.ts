import type { HealthReport } from "@/lib/ikas/types";

/**
 * The merchant-facing health model.
 *
 * The shipped score subtracted an un-normalized penalty from 100, so the same proportion of
 * problems produced 57/100 in a ten-product store and 0/100 in a hundred-product one, and an
 * empty store scored a perfect 100. This module replaces that with a size-comparable model:
 * the weighted penalty is divided by the number of products scanned, so catalogs of different
 * sizes are measured on the same scale.
 *
 * The model is a *definition*, not a measurement. The weights and the ceiling below are
 * chosen so the result is explainable to a merchant; none of them is derived from observed
 * production score distributions, and nothing here should be presented as a claim about how
 * often any rule fails in real stores.
 *
 * This is derived from a stored snapshot rather than persisted with it, so the model can be
 * re-tuned without invalidating snapshots that were written under an older one.
 */

export type HealthState = "unknown" | "good" | "attention" | "critical";

/** Weighted cost of one issue, by severity. Matches the severities the rules already assign. */
export const HEALTH_SEVERITY_WEIGHTS: Record<"critical" | "warning" | "info", number> = {
  critical: 7,
  warning: 4,
  info: 1,
};

/**
 * The per-product penalty that maps to a score of zero. Twenty points is roughly three
 * critical issues on every product in the catalog; past that the score is already zero and
 * further problems cannot make it lower. Chosen as a legible reference point, not measured.
 */
export const HEALTH_PENALTY_CEILING_PER_PRODUCT = 20;

/** Score at or above which a catalog is in each state. Ordered from best to worst. */
export const HEALTH_STATE_THRESHOLDS = {
  good: 85,
  attention: 60,
} as const;

export const HEALTH_STATE_LABELS: Record<HealthState, string> = {
  unknown: "Taranacak ürün yok",
  good: "İyi durumda",
  attention: "İyileştirme gerekiyor",
  critical: "Acil müdahale gerekiyor",
};

/**
 * Short merchant-facing explanation of the number above. Kept beside the model so a change to
 * the weights or the ceiling and a change to the published methodology cannot drift apart.
 */
export const HEALTH_METHODOLOGY_LINES = [
  `Her sorun ağırlıklandırılır: kritik ${HEALTH_SEVERITY_WEIGHTS.critical}, uyarı ${HEALTH_SEVERITY_WEIGHTS.warning}, bilgi ${HEALTH_SEVERITY_WEIGHTS.info} puan.`,
  "Toplam ağırlık taranan ürün sayısına bölünür, böylece küçük ve büyük kataloglar aynı ölçekte karşılaştırılır.",
  `Ürün başına ${HEALTH_PENALTY_CEILING_PER_PRODUCT} puan ve üzeri 0 skoruna karşılık gelir.`,
  "Skor bu tanıma dayanır; gerçek mağazalardan ölçülmüş bir dağılıma değil.",
] as const;

/** Only the aggregates the model needs, so any snapshot report satisfies it. */
export type HealthAssessmentInput = Pick<
  HealthReport,
  "productCount" | "affectedProductCount" | "criticalCount" | "warningCount" | "infoCount"
>;

export type HealthAssessment = {
  state: HealthState;
  label: string;
  /** Null when there is nothing to score. A store with no products has no health result. */
  score: number | null;
  /** Null alongside a null score. Exposed so the summary can show the working. */
  penaltyPerProduct: number | null;
  productCount: number;
  affectedProductCount: number;
  criticalCount: number;
};

/** Negative or non-finite counts are treated as zero rather than allowed to move the score. */
function safeCount(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function stateForScore(score: number): HealthState {
  if (score >= HEALTH_STATE_THRESHOLDS.good) return "good";
  if (score >= HEALTH_STATE_THRESHOLDS.attention) return "attention";
  return "critical";
}

export function assessHealth(report: HealthAssessmentInput): HealthAssessment {
  const productCount = safeCount(report.productCount);
  const criticalCount = safeCount(report.criticalCount);
  const affectedProductCount = safeCount(report.affectedProductCount);

  const base = {
    productCount,
    affectedProductCount,
    criticalCount,
  };

  // No products means no denominator and no honest result. An empty store is not a healthy
  // store, so it gets an explicit "nothing to score" state instead of a flattering number.
  if (productCount === 0) {
    return {
      ...base,
      state: "unknown",
      label: HEALTH_STATE_LABELS.unknown,
      score: null,
      penaltyPerProduct: null,
    };
  }

  const weightedPenalty =
    criticalCount * HEALTH_SEVERITY_WEIGHTS.critical +
    safeCount(report.warningCount) * HEALTH_SEVERITY_WEIGHTS.warning +
    safeCount(report.infoCount) * HEALTH_SEVERITY_WEIGHTS.info;

  const penaltyPerProduct = weightedPenalty / productCount;
  const score = Math.round(
    100 * (1 - Math.min(1, penaltyPerProduct / HEALTH_PENALTY_CEILING_PER_PRODUCT)),
  );

  return {
    ...base,
    state: stateForScore(score),
    label: HEALTH_STATE_LABELS[stateForScore(score)],
    score,
    penaltyPerProduct,
  };
}
