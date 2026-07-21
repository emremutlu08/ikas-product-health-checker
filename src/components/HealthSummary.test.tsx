import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assessHealth } from "@/lib/health/health-model";
import { HealthSummary } from "./HealthSummary";

const render = (input: Parameters<typeof assessHealth>[0]) =>
  renderToStaticMarkup(<HealthSummary assessment={assessHealth(input)} />);

const healthy = {
  productCount: 120,
  affectedProductCount: 3,
  criticalCount: 1,
  warningCount: 2,
  infoCount: 1,
};

/** 15.7 weighted points per product, well past the ceiling's midpoint, so this scores 22. */
const troubled = {
  productCount: 100,
  affectedProductCount: 44,
  criticalCount: 200,
  warningCount: 40,
  infoCount: 10,
};

describe("the health state is explainable", () => {
  it("states the health as words alongside the number", () => {
    const html = render(healthy);

    expect(html).toContain("İyi durumda");
    expect(html).toContain("/100");
  });

  it("shows a worse state for a worse catalog", () => {
    expect(render(troubled)).toContain("Acil müdahale gerekiyor");
  });

  it("publishes the scoring methodology next to the score", () => {
    const html = render(healthy);

    expect(html).toContain("Skor nasıl hesaplanır?");
    expect(html).toContain("kritik 7");
    expect(html).toContain("taranan ürün sayısına bölünür");
  });

  it("does not claim the score reflects measured real-world stores", () => {
    const html = render(healthy);

    expect(html).toContain("gerçek mağazalardan ölçülmüş bir dağılıma değil");
    expect(html).not.toContain("ortalama mağaza");
  });
});

describe("a store with no products has no score", () => {
  const empty = {
    productCount: 0,
    affectedProductCount: 0,
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
  };

  it("renders no numeric score at all", () => {
    const html = render(empty);

    expect(html).not.toContain("/100");
    expect(html).not.toContain("100/100");
  });

  it("explains why instead of showing a flattering number", () => {
    expect(render(empty)).toContain("Taranacak ürün yok");
  });
});

describe("compact priority hierarchy", () => {
  it("shows critical issue count and affected products", () => {
    const html = render(healthy);

    expect(html).toContain("Kritik sorun");
    expect(html).toContain("Etkilenen ürün");
    expect(html).toContain(">1<");
    expect(html).toContain(">3<");
  });

  it("puts affected products in the context of the catalog size", () => {
    expect(render(healthy)).toContain("120");
  });

  it("omits change-since-last-scan because only the latest snapshot is stored", () => {
    const html = render(healthy);

    for (const trend of ["değişim", "Önceki tarama", "geçen taramaya göre", "▲", "▼"]) {
      expect(html).not.toContain(trend);
    }
  });

  it("uses no decorative glyphs or rating stars", () => {
    const html = render(healthy);

    for (const glyph of ["★", "☆", "🎉", "⚠️", "✅"]) {
      expect(html).not.toContain(glyph);
    }
  });
});

describe("state is never communicated by colour alone", () => {
  it("pairs every state with its own text label", () => {
    expect(render(healthy)).toContain("İyi durumda");
    expect(render(troubled)).toContain("Acil müdahale gerekiyor");
  });

  it("uses semantic tokens rather than ad-hoc palette steps", () => {
    expect(render(healthy)).not.toMatch(/(slate|orange|violet|emerald|amber)-\d{2,3}/);
  });
});
