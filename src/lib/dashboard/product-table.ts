import { ISSUE_TO_RULE, MISTAKE_RULE_CODES, RULE_LABELS } from "@/lib/ikas/health-rules";
import type {
  HealthIssueSeverity,
  HealthReport,
  MistakeRuleCode,
  ProductMistakeRow,
} from "@/lib/ikas/types";

/**
 * Table state for the operational product list.
 *
 * Search, sort, filter and pagination are all URL-driven, so they survive a reload, can be
 * linked, and — crucially — are pure projections of the snapshot the last scan stored. None
 * of this reaches the ikas catalog. Every value that arrives from the URL is validated
 * against an allowlist here rather than trusted, and every ordering ends in a product-id
 * tie-break so the same query always renders the same page.
 */

export const PRODUCT_TABLE_PAGE_SIZE = 25;

/** Bounds a pasted or crafted search term before it reaches comparison or the DOM. */
export const MAX_SEARCH_LENGTH = 100;

/**
 * Absolute ceiling on a parsed page number, before the real page count is known.
 *
 * A snapshot holds at most `MAX_SNAPSHOT_PRODUCT_ROWS` (10 000) rows, so at 25 rows a page the
 * largest page that can ever exist is 400. This bounds parsing an order of magnitude above
 * that: selection still clamps to the actual `pageCount`, so the cap changes no rendered
 * result — it just means every value leaving this parser is a small, printable number rather
 * than one that only stays harmless because a later stage happens to clamp it.
 */
export const MAX_PRODUCT_TABLE_PAGE = 5_000;

export const PRODUCT_TABLE_SORTS = ["severity", "name", "updated"] as const;
export type ProductTableSort = (typeof PRODUCT_TABLE_SORTS)[number];

export const SORT_LABELS: Record<ProductTableSort, string> = {
  severity: "Öncelik",
  name: "Ürün adı",
  updated: "Güncellenme",
};

export const SEVERITY_LABELS: Record<HealthIssueSeverity, string> = {
  critical: "Kritik",
  warning: "Uyarı",
  info: "Bilgi",
};

const SEVERITY_RANK: Record<HealthIssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

export type ProductIssueRow = ProductMistakeRow & {
  /** Null when a stored row carries no matching issue; never guessed upward. */
  severity: HealthIssueSeverity | null;
};

export type ProductTableQuery = {
  rule?: MistakeRuleCode;
  search: string;
  sort: ProductTableSort;
  page: number;
};

export type ProductTableSelection = {
  rows: ProductIssueRow[];
  totalRows: number;
  page: number;
  pageCount: number;
  /** 1-based inclusive range of the rendered rows; both zero when nothing matched. */
  rangeStart: number;
  rangeEnd: number;
  severityCounts: Record<HealthIssueSeverity, number>;
};

type QueryParams = Record<string, string | string[] | undefined>;

/**
 * A repeated query parameter arrives as an array. Rather than pick one arbitrarily, the value
 * is discarded and the default applies — an ambiguous filter should never silently become a
 * specific one.
 */
function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const collator = new Intl.Collator("tr-TR", { sensitivity: "base", numeric: true });

export function parseProductTableQuery(params: QueryParams): ProductTableQuery {
  const rawRule = singleValue(params.rule);
  const rule = (MISTAKE_RULE_CODES as readonly string[]).includes(rawRule ?? "")
    ? (rawRule as MistakeRuleCode)
    : undefined;

  const rawSort = singleValue(params.sort);
  const sort = (PRODUCT_TABLE_SORTS as readonly string[]).includes(rawSort ?? "")
    ? (rawSort as ProductTableSort)
    : "severity";

  const search = (singleValue(params.q) ?? "").trim().slice(0, MAX_SEARCH_LENGTH);

  const rawPage = Number.parseInt(singleValue(params.page) ?? "", 10);
  const page =
    Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, MAX_PRODUCT_TABLE_PAGE) : 1;

  return { rule, search, sort, page };
}

/**
 * Joins each stored product row to the severity of the worst issue behind it. Only issues that
 * roll up into a merchant-facing rule count, because those are the only ones the row's mistake
 * labels — and therefore the rule filter — are built from.
 */
export function buildProductIssueRows(
  report: Pick<HealthReport, "productRows" | "issues">,
): ProductIssueRow[] {
  const worstByProduct = new Map<string, HealthIssueSeverity>();

  for (const issue of report.issues) {
    if (!ISSUE_TO_RULE[issue.code]) continue;
    const current = worstByProduct.get(issue.productId);
    if (!current || SEVERITY_RANK[issue.severity] < SEVERITY_RANK[current]) {
      worstByProduct.set(issue.productId, issue.severity);
    }
  }

  return report.productRows.map((row) => ({
    ...row,
    severity: worstByProduct.get(row.productId) ?? null,
  }));
}

function updatedAtValue(row: ProductIssueRow) {
  if (!row.updatedAt) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(row.updatedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** A row with no known severity sorts after every known one rather than jumping to the top. */
function severityValue(row: ProductIssueRow) {
  return row.severity ? SEVERITY_RANK[row.severity] : SEVERITY_RANK.info + 1;
}

function compareRows(sort: ProductTableSort) {
  return (a: ProductIssueRow, b: ProductIssueRow) => {
    if (sort === "severity") {
      const bySeverity = severityValue(a) - severityValue(b);
      if (bySeverity !== 0) return bySeverity;
      const byBreadth = b.mistakes.length - a.mistakes.length;
      if (byBreadth !== 0) return byBreadth;
    }

    if (sort === "updated") {
      // Compared for equality first: subtracting two rows that both lack a timestamp would
      // produce NaN, which silently discards the tie-breaks below and makes the order depend
      // on the input sequence.
      const aUpdated = updatedAtValue(a);
      const bUpdated = updatedAtValue(b);
      if (aUpdated !== bUpdated) return bUpdated - aUpdated;
    }

    const byName = collator.compare(a.productName, b.productName);
    if (byName !== 0) return byName;

    // Final tie-break, always. Two rows that compare equal on everything else must still
    // render in the same order on every request, or pagination would drop or repeat rows.
    return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
  };
}

export function selectProductTableRows(
  rows: ProductIssueRow[],
  query: Pick<ProductTableQuery, "sort" | "page" | "search"> & { rule?: MistakeRuleCode },
): ProductTableSelection {
  const ruleLabel = query.rule ? RULE_LABELS[query.rule] : undefined;
  const needle = query.search.toLocaleLowerCase("tr-TR");

  const matching = rows.filter((row) => {
    if (ruleLabel && !row.mistakes.includes(ruleLabel)) return false;
    if (needle && !row.productName.toLocaleLowerCase("tr-TR").includes(needle)) return false;
    return true;
  });

  // Counted over everything that matched, not over the rendered page, so the summary
  // describes the merchant's actual problem set rather than the current slice of it.
  const severityCounts: Record<HealthIssueSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const row of matching) {
    if (row.severity) severityCounts[row.severity] += 1;
  }

  const sorted = [...matching].sort(compareRows(query.sort));

  const totalRows = sorted.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PRODUCT_TABLE_PAGE_SIZE));
  const page = Math.min(Math.max(1, query.page), pageCount);
  const start = (page - 1) * PRODUCT_TABLE_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + PRODUCT_TABLE_PAGE_SIZE);

  return {
    rows: pageRows,
    totalRows,
    page,
    pageCount,
    rangeStart: pageRows.length ? start + 1 : 0,
    rangeEnd: pageRows.length ? start + pageRows.length : 0,
    severityCounts,
  };
}
