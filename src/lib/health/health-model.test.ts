import { describe, expect, it } from "vitest";
import { buildHealthReport } from "@/lib/ikas/health-rules";
import {
  AFFECTED_PRODUCT_RATIO,
  buildCatalogFixture,
  CATALOG_FIXTURE_SIZES,
} from "./catalog-fixtures";
import {
  assessHealth,
  HEALTH_PENALTY_CEILING_PER_PRODUCT,
  HEALTH_SEVERITY_WEIGHTS,
  HEALTH_STATE_LABELS,
} from "./health-model";

const reportFor = (size: number) => buildHealthReport(buildCatalogFixture(size));

describe("recorded behaviour of the previous absolute score", () => {
  /**
   * Recorded, not endorsed. Every fixture below has the same proportion of affected products
   * and the same issue mix per affected product, so a size-comparable model must return the
   * same answer for all of them. The shipped formula subtracted an un-normalized penalty and
   * did not, which is the defect this module replaces.
   */
  it("collapses to zero as catalog size grows at constant issue density", () => {
    expect(reportFor(10).score).toBe(57);
    expect(reportFor(100).score).toBe(0);
    expect(reportFor(1000).score).toBe(0);
  });

  it("awards a perfect score to a store with nothing in it", () => {
    expect(reportFor(0).score).toBe(100);
  });
});

describe("zero-product stores have no numeric score", () => {
  it("reports an unknown state and a null score rather than a perfect one", () => {
    const assessment = assessHealth(reportFor(0));

    expect(assessment.score).toBeNull();
    expect(assessment.state).toBe("unknown");
    expect(assessment.penaltyPerProduct).toBeNull();
  });

  it("labels the unknown state in merchant-facing Turkish", () => {
    expect(HEALTH_STATE_LABELS.unknown).toBe("Taranacak ürün yok");
  });
});

describe("equal issue density scores the same across catalog sizes", () => {
  const assessments = CATALOG_FIXTURE_SIZES.map((size) => assessHealth(reportFor(size)));

  it("returns an identical score for 10, 100, and 1000 products", () => {
    const scores = assessments.map((assessment) => assessment.score);

    expect(scores).toEqual([76, 76, 76]);
  });

  it("returns an identical state for every size band", () => {
    expect(assessments.map((assessment) => assessment.state)).toEqual([
      "attention",
      "attention",
      "attention",
    ]);
  });

  it("scales the affected product count with the catalog while holding the ratio", () => {
    expect(assessments.map((assessment) => assessment.affectedProductCount)).toEqual([2, 20, 200]);
    for (const [index, assessment] of assessments.entries()) {
      expect(assessment.affectedProductCount / CATALOG_FIXTURE_SIZES[index]!).toBeCloseTo(
        AFFECTED_PRODUCT_RATIO,
      );
    }
  });
});

describe("the score is bounded and derived from documented weights", () => {
  it("stays inside 0..100 for a catalog where every product fails everything", () => {
    const assessment = assessHealth({
      productCount: 4,
      affectedProductCount: 4,
      criticalCount: 400,
      warningCount: 400,
      infoCount: 400,
    });

    expect(assessment.score).toBe(0);
    expect(assessment.state).toBe("critical");
  });

  it("awards 100 to a catalog with no issues at all", () => {
    const assessment = assessHealth({
      productCount: 250,
      affectedProductCount: 0,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
    });

    expect(assessment.score).toBe(100);
    expect(assessment.state).toBe("good");
  });

  it("weights one product's penalty exactly as the published methodology states", () => {
    const assessment = assessHealth({
      productCount: 1,
      affectedProductCount: 1,
      criticalCount: 1,
      warningCount: 1,
      infoCount: 1,
    });

    const penalty =
      HEALTH_SEVERITY_WEIGHTS.critical +
      HEALTH_SEVERITY_WEIGHTS.warning +
      HEALTH_SEVERITY_WEIGHTS.info;

    expect(assessment.penaltyPerProduct).toBe(penalty);
    expect(assessment.score).toBe(
      Math.round(100 * (1 - penalty / HEALTH_PENALTY_CEILING_PER_PRODUCT)),
    );
  });

  it("treats the ceiling as the point where the score reaches zero", () => {
    const assessment = assessHealth({
      productCount: 10,
      affectedProductCount: 10,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 10 * HEALTH_PENALTY_CEILING_PER_PRODUCT,
    });

    expect(assessment.penaltyPerProduct).toBe(HEALTH_PENALTY_CEILING_PER_PRODUCT);
    expect(assessment.score).toBe(0);
  });
});

describe("state banding is explainable and severity-aware", () => {
  const at = (penaltyPerProduct: number) =>
    assessHealth({
      productCount: 100,
      affectedProductCount: 10,
      criticalCount: 0,
      warningCount: 0,
      infoCount: penaltyPerProduct * 100,
    });

  it("calls a nearly clean catalog good", () => {
    expect(at(1).state).toBe("good");
  });

  it("calls a middling catalog attention", () => {
    expect(at(5).state).toBe("attention");
  });

  it("calls a heavily affected catalog critical", () => {
    expect(at(12).state).toBe("critical");
  });

  it("gives every state a distinct Turkish label so state is never colour-only", () => {
    const labels = Object.values(HEALTH_STATE_LABELS);

    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });
});

describe("fail-closed input handling", () => {
  it("refuses to score a negative or non-finite product count", () => {
    expect(
      assessHealth({
        productCount: -1,
        affectedProductCount: 0,
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
      }).score,
    ).toBeNull();
    expect(
      assessHealth({
        productCount: Number.NaN,
        affectedProductCount: 0,
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
      }).state,
    ).toBe("unknown");
  });

  it("ignores negative severity counts instead of inflating the score above 100", () => {
    const assessment = assessHealth({
      productCount: 10,
      affectedProductCount: 0,
      criticalCount: -50,
      warningCount: 0,
      infoCount: 0,
    });

    expect(assessment.score).toBe(100);
  });
});
