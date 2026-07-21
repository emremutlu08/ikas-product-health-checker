import type { MistakeRuleCode, MistakeRuleSummary } from "@/lib/ikas/types";

/**
 * URL-driven rule filters.
 *
 * These are links, not buttons: each one is a real destination that can be linked, opened in
 * a new tab, and reached with the browser's back button. That also makes `aria-pressed`
 * wrong here — a link that navigates is not a toggle — so the active filter is announced with
 * `aria-current="page"` instead.
 *
 * Following a filter re-renders from the stored snapshot. It never reaches the ikas catalog.
 */

export type RuleFiltersProps = {
  summaries: MistakeRuleSummary[];
  selectedRule?: MistakeRuleCode;
  /** Builds the destination for a rule, or for the unfiltered view when omitted. */
  hrefForRule(rule?: MistakeRuleCode): string;
};

export function RuleFilters({ summaries, selectedRule, hrefForRule }: RuleFiltersProps) {
  return (
    <section
      aria-labelledby="rule-filters-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-title font-semibold text-text" id="rule-filters-heading">
            Kurallar
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Etkilenen ürünleri görmek için bir kural seçin. Tüm kontroller salt okunurdur.
          </p>
        </div>
        {selectedRule ? (
          <a
            className="inline-flex min-h-11 w-fit items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
            href={hrefForRule()}
          >
            Filtreyi temizle
          </a>
        ) : null}
      </div>

      <nav aria-label="Kural filtresi" className="mt-4">
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {summaries.map((rule) => {
            const active = selectedRule === rule.code;
            return (
              <li key={rule.code}>
                <a
                  aria-current={active ? "page" : undefined}
                  // The visible badge is decorative and hidden below, so the count lives in
                  // the accessible name instead of being lost to screen-reader users.
                  aria-label={`${rule.label}, ${rule.count} ürün${active ? ", seçili filtre" : ""}`}
                  className={`flex min-h-11 items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm transition ${
                    active
                      ? "border-accent bg-accent-soft font-semibold text-accent"
                      : "border-border bg-surface text-text hover:bg-surface-sunken"
                  }`}
                  href={hrefForRule(rule.code)}
                >
                  <span className="flex items-center gap-2">
                    {/* Non-colour active cue: a left marker plus the word below. */}
                    {active ? (
                      <span aria-hidden="true" className="h-4 w-1 rounded-sm bg-accent" />
                    ) : null}
                    {rule.label}
                    {active ? <span className="text-label font-semibold">Seçili</span> : null}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`inline-flex min-w-7 justify-center rounded-sm px-2 py-0.5 text-sm font-semibold tabular-nums ${
                      rule.count === 0
                        ? "bg-success-surface text-success"
                        : "bg-critical-surface text-critical"
                    }`}
                  >
                    {rule.count}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </section>
  );
}
