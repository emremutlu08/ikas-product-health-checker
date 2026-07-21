import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DashboardHeader } from "@/components/DashboardHeader";
import { HealthSummary } from "@/components/HealthSummary";
import { ProductIssueTable } from "@/components/ProductIssueTable";
import { RuleFilters } from "@/components/RuleFilters";
import {
  buildProductIssueRows,
  parseProductTableQuery,
  selectProductTableRows,
  type ProductTableQuery,
} from "@/lib/dashboard/product-table";
import { assessHealth } from "@/lib/health/health-model";
import { ISSUE_TO_RULE, RULE_LABELS } from "@/lib/ikas/health-rules";
import type {
  HealthIssue,
  HealthIssueCode,
  HealthIssueSeverity,
  HealthReport,
  MistakeRuleCode,
  ProductMistakeRow,
} from "@/lib/ikas/types";

/**
 * A test-only harness that renders the authenticated dashboard as static markup.
 *
 * The dashboard is the screen most likely to break at an embedded width, and it is the one
 * screen a browser cannot reach without an installation session. The alternatives were all
 * worse than the problem: a seed route, a test-only auth bypass, or a stubbed session would
 * each put a way into the authenticated surface into production code, and the reviewer's whole
 * concern is that nothing does that.
 *
 * So the browser loads the real app first — that is where the compiled Tailwind stylesheet and
 * the real token values come from — and only `document.body` is swapped for this markup. The
 * components, the projection functions and the health model below are the production ones, not
 * copies; only the report they are fed is sample data. What that buys is a genuine layout and
 * accessibility check: overflow, focus rings, landmark names and reachability are properties of
 * real CSS applied to real markup, and none of them can be observed from a rendered string.
 *
 * What it deliberately does not cover is anything about how the page gets its data — session
 * handling, tenant scoping and the scan lease are all server concerns, tested server-side.
 *
 * ## Why this module is not imported by the Playwright spec
 *
 * Playwright compiles the files it loads with its own component-testing JSX transform, which
 * turns the app's JSX into Playwright element descriptors rather than React elements;
 * `renderToStaticMarkup` then rejects them ("Objects are not valid as a React child"). Rendering
 * therefore happens under Vitest — the project's declared, already-configured React transform —
 * and the result is handed to Playwright as the JSON artifact this module's companion emits.
 * The indirection buys nothing except a working transform, so it is confined to one file each
 * side and the components stay the real ones.
 */

/** Fixed so the rendered timestamps never depend on when the suite runs. */
const GENERATED_AT = "2026-05-14T09:30:00.000Z";

const STORE_NAME = "ornek-magaza";

/** One representative issue per merchant-facing rule, with the severity that rule carries. */
const RULE_ISSUE: Record<MistakeRuleCode, { code: HealthIssueCode; severity: HealthIssueSeverity }> =
  {
    incorrect_price: { code: "missing_price", severity: "critical" },
    missing_sku: { code: "missing_sku", severity: "critical" },
    same_sku: { code: "duplicate_sku", severity: "critical" },
    out_of_stock: { code: "zero_stock_blocked", severity: "warning" },
    missing_images: { code: "missing_image", severity: "warning" },
    duplicate_title: { code: "duplicate_title", severity: "warning" },
    weird_description: { code: "weird_description", severity: "info" },
  };

/**
 * Turkish names on purpose. The table sorts with a tr-TR collator and the layout has to hold
 * the diacritics and the longer words that Turkish copy actually produces, so ASCII placeholder
 * names would make the widths measured here optimistic.
 */
const PRODUCT_NAMES = [
  "Şile Bezi Gömlek",
  "İpek Eşarp",
  "Oduncu Gömleği",
  "Çizgili Triko Kazak",
  "Yünlü Kışlık Kaban",
  "Deri Omuz Çantası",
  "Pamuklu Bebek Body",
  "Uzun Kollu Sweatshirt",
  "Günlük Spor Ayakkabı",
  "Keten Yazlık Pantolon",
];

/**
 * Rule mix per row, cycled. Chosen so every rule is represented, some rows carry several
 * mistakes at once (the widest cell the table has to fit) and some carry only one.
 */
const RULE_CYCLE: MistakeRuleCode[][] = [
  ["missing_sku", "missing_images", "weird_description"],
  ["incorrect_price"],
  ["out_of_stock", "duplicate_title"],
  ["same_sku", "missing_images"],
  ["weird_description"],
  ["incorrect_price", "missing_sku", "out_of_stock", "duplicate_title"],
];

/** 30 rows: enough to overflow the 25-row page size and render real pagination. */
const ROW_COUNT = 30;

function buildSampleReport(): HealthReport {
  const productRows: ProductMistakeRow[] = [];
  const issues: HealthIssue[] = [];

  for (let index = 0; index < ROW_COUNT; index += 1) {
    const productId = `sample-product-${String(index + 1).padStart(3, "0")}`;
    const productName = `${PRODUCT_NAMES[index % PRODUCT_NAMES.length]} ${index + 1}`;
    const rules = RULE_CYCLE[index % RULE_CYCLE.length];

    productRows.push({
      productId,
      productName,
      imageLabel: productName,
      // Left undefined so the preview renders its fallback tile rather than reaching the
      // network from a test.
      imageSrc: undefined,
      updatedAt: new Date(Date.UTC(2026, 3, 1 + (index % 28), 12)).toISOString(),
      mistakes: rules.map((rule) => RULE_LABELS[rule]),
      actionLabel: "Ürünü düzenle",
    });

    for (const rule of rules) {
      const { code, severity } = RULE_ISSUE[rule];
      issues.push({
        code,
        severity,
        productId,
        productName,
        message: `${RULE_LABELS[rule]} sorunu tespit edildi.`,
      });
    }
  }

  // Counted from the issues above rather than asserted, so the summary and the table can never
  // describe different data.
  const severityCounts: Record<HealthIssueSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) severityCounts[issue.severity] += 1;

  const issueCountsByCode = {} as HealthReport["issueCountsByCode"];
  for (const issue of issues) {
    issueCountsByCode[issue.code] = (issueCountsByCode[issue.code] ?? 0) + 1;
  }

  const ruleSummaries = (Object.keys(RULE_ISSUE) as MistakeRuleCode[]).map((code) => ({
    code,
    label: RULE_LABELS[code],
    count: productRows.filter((row) => row.mistakes.includes(RULE_LABELS[code])).length,
  }));

  return {
    generatedAt: GENERATED_AT,
    // Legacy persisted field. The merchant-facing number comes from `assessHealth`.
    score: 0,
    productCount: 120,
    variantCount: 260,
    issueCount: issues.length,
    affectedProductCount: productRows.length,
    scanStatus: "success",
    issueCountsByCode,
    criticalCount: severityCounts.critical,
    warningCount: severityCounts.warning,
    infoCount: severityCounts.info,
    outOfStockBlockedCount: 7,
    ruleSummaries,
    productRows,
    issues,
  };
}

function buildHref(query: ProductTableQuery, patch: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = {
    rule: query.rule,
    q: query.search || undefined,
    sort: query.sort === "severity" ? undefined : query.sort,
    page: query.page > 1 ? String(query.page) : undefined,
    ...patch,
  };

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }

  const search = params.toString();
  return search ? `/?${search}` : "/";
}

/**
 * Everything the browser-side spec needs. It is serialised to JSON rather than imported,
 * because the spec runs under a transform that cannot compile the components above.
 */
export type DashboardHarness = {
  html: string;
  storeName: string;
  /** The last row the default view renders — the worst case for reachability. */
  lastProductName: string;
  /** Rows on the first page, so the spec can assert it is measuring a full table. */
  renderedRowCount: number;
};

/**
 * Mirrors the element tree of the authenticated branch of `src/app/page.tsx`, including its
 * wrapper classes — those carry the max width and the responsive padding, so measuring the
 * components without them would measure a layout that never ships.
 */
export function buildDashboardHarness(): DashboardHarness {
  const report = buildSampleReport();
  const query = parseProductTableQuery({});
  const allRows = buildProductIssueRows(report);
  const selection = selectProductTableRows(allRows, query);

  const tree: ReactElement = createElement(
    "main",
    { className: "min-h-screen bg-canvas text-text" },
    createElement(
      "div",
      { className: "mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8" },
      createElement(DashboardHeader, {
        csvHref: "/api/report.csv",
        generatedAt: report.generatedAt,
        key: "header",
        scanBusy: false,
        stale: false,
        storeName: STORE_NAME,
      }),
      createElement(HealthSummary, { assessment: assessHealth(report), key: "summary" }),
      createElement(RuleFilters, {
        hrefForRule: (rule?: MistakeRuleCode) => buildHref(query, { rule, page: undefined }),
        key: "filters",
        selectedRule: undefined,
        summaries: report.ruleSummaries,
      }),
      createElement(ProductIssueTable, {
        buildHref: (patch: Record<string, string | undefined>) => buildHref(query, patch),
        key: "table",
        productCount: report.productCount,
        query,
        selection,
        storeName: STORE_NAME,
        totalAffectedProducts: allRows.length,
      }),
    ),
  );

  return {
    html: renderToStaticMarkup(tree),
    lastProductName: selection.rows[selection.rows.length - 1].productName,
    renderedRowCount: selection.rows.length,
    storeName: STORE_NAME,
  };
}

/**
 * Every rule in the sample data must roll up through the production issue map, or the harness
 * would be rendering a rule mix the real report can never produce.
 */
export function harnessRuleMappingIsConsistent() {
  return (Object.keys(RULE_ISSUE) as MistakeRuleCode[]).every(
    (rule) => ISSUE_TO_RULE[RULE_ISSUE[rule].code] === rule,
  );
}
