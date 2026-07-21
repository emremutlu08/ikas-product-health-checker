import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MistakeRuleCode, MistakeRuleSummary } from "@/lib/ikas/types";
import { RuleFilters } from "./RuleFilters";

const summaries: MistakeRuleSummary[] = [
  { code: "missing_sku", label: "SKU Eksik", count: 4 },
  { code: "out_of_stock", label: "Stokta Yok", count: 0 },
  { code: "missing_images", label: "Görsel Eksik", count: 1 },
];

const hrefForRule = (rule?: MistakeRuleCode) => (rule ? `/?rule=${rule}` : "/");

const render = (selectedRule?: MistakeRuleCode) =>
  renderToStaticMarkup(
    <RuleFilters hrefForRule={hrefForRule} selectedRule={selectedRule} summaries={summaries} />,
  );

describe("navigation semantics", () => {
  it("is a labelled navigation landmark", () => {
    const html = render();

    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Kural filtresi"');
  });

  it("keeps every filter a link so URL state stays shareable and back works", () => {
    const html = render();

    expect(html).toContain('href="/?rule=missing_sku"');
    expect(html).toContain('href="/?rule=out_of_stock"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-pressed");
  });

  it("marks the active filter with aria-current=page", () => {
    const html = render("missing_sku");

    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("marks nothing as current when no filter is active", () => {
    expect(render()).not.toContain("aria-current");
  });
});

describe("accessible labelling", () => {
  it("includes the count in the accessible name of each filter", () => {
    const html = render();

    expect(html).toContain('aria-label="SKU Eksik, 4 ürün"');
    expect(html).toContain('aria-label="Stokta Yok, 0 ürün"');
  });

  it("says in the accessible name when a filter is the active one", () => {
    expect(render("missing_sku")).toContain('aria-label="SKU Eksik, 4 ürün, seçili filtre"');
  });

  it("hides the decorative count badge from assistive technology", () => {
    const html = render();

    expect(html).toContain('aria-hidden="true"');
  });
});

describe("active state is not carried by colour alone", () => {
  it("renders a visible textual cue on the active filter", () => {
    const html = render("missing_sku");

    expect(html).toContain("Seçili");
  });

  it("shows no such cue when the filter is inactive", () => {
    expect(render()).not.toContain("Seçili");
  });
});

describe("clearing the filter", () => {
  it("offers a secondary clear action only while a filter is active", () => {
    const active = render("missing_sku");

    expect(active).toContain("Filtreyi temizle");
    expect(active).toContain('href="/"');
  });

  it("does not render a clear action when nothing is filtered", () => {
    expect(render()).not.toContain("Filtreyi temizle");
  });
});

describe("visual system", () => {
  it("uses semantic tokens rather than ad-hoc palette steps", () => {
    expect(render("missing_sku")).not.toMatch(/(slate|orange|violet|emerald|amber)-\d{2,3}/);
  });
});
