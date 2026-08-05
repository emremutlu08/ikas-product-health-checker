import type { CorrectableTarget } from "@/components/CorrectionPanel";

/**
 * URL-driven search and pagination for the correction list.
 *
 * Filtering and slicing happen here, on the server, rather than in the browser. A scan of a large
 * catalog can produce thousands of correctable variants, and shipping all of them so the client can
 * hide most is both a slow first paint and a needless copy of the merchant's catalog in a page
 * payload. It also means the state lives in the URL: a filtered view survives a reload, can be
 * linked, and the back button behaves.
 *
 * Nothing here touches ikas. Every value is a projection of the snapshot the last scan stored, and
 * every value arriving from the URL is validated rather than trusted.
 */

/** One screen of work. Large enough to scan, small enough to keep the payload and DOM sane. */
export const CORRECTION_PAGE_SIZE = 50;

/** Bounds a pasted or crafted search term before it reaches comparison or the DOM. */
export const MAX_CORRECTION_SEARCH_LENGTH = 100;

/**
 * Ceiling on a parsed page number, before the real page count is known. Selection clamps to the
 * actual `pageCount` anyway, so this changes no rendered result — it only guarantees that every
 * number leaving the parser is small and printable rather than harmless by luck.
 */
export const MAX_CORRECTION_PAGE = 5_000;

export type CorrectionQuery = {
  search: string;
  page: number;
};

export type CorrectionSelection = {
  targets: CorrectableTarget[];
  /** Matching the search, before pagination. */
  totalTargets: number;
  /** Every correctable target in the snapshot, ignoring the search. */
  unfilteredTargets: number;
  page: number;
  pageCount: number;
  /** 1-based inclusive range of the rendered targets; both zero when nothing matched. */
  rangeStart: number;
  rangeEnd: number;
};

type QueryParams = Record<string, string | string[] | undefined>;

/**
 * A repeated query parameter arrives as an array. Rather than pick one arbitrarily, the value is
 * discarded and the default applies — an ambiguous filter should never silently become a specific
 * one.
 */
function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseCorrectionQuery(params: QueryParams): CorrectionQuery {
  const search = (singleValue(params.q) ?? "").trim().slice(0, MAX_CORRECTION_SEARCH_LENGTH);

  const rawPage = Number.parseInt(singleValue(params.page) ?? "", 10);
  const page =
    Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, MAX_CORRECTION_PAGE) : 1;

  return { search, page };
}

/**
 * Turkish locale on purpose: `toLocaleLowerCase("tr-TR")` maps `İ` to `i` and `I` to `ı`, so a
 * merchant typing on a Turkish keyboard finds "İpek Eşarp" by typing "ipek". The default locale
 * would leave a dotted capital unmatched.
 */
function normalise(value: string) {
  return value.toLocaleLowerCase("tr-TR");
}

function matches(target: CorrectableTarget, needle: string) {
  return normalise(`${target.productName} ${target.variantLabel ?? ""}`).includes(needle);
}

export function selectCorrections(
  targets: CorrectableTarget[],
  query: CorrectionQuery,
): CorrectionSelection {
  const needle = normalise(query.search);
  const matched = needle ? targets.filter((target) => matches(target, needle)) : targets;

  const pageCount = Math.max(1, Math.ceil(matched.length / CORRECTION_PAGE_SIZE));
  // A page number past the end lands on the last page rather than an empty screen, so a stale
  // link or a deleted issue never looks like "you have no corrections".
  const page = Math.min(query.page, pageCount);
  const start = (page - 1) * CORRECTION_PAGE_SIZE;
  const pageTargets = matched.slice(start, start + CORRECTION_PAGE_SIZE);

  return {
    targets: pageTargets,
    totalTargets: matched.length,
    unfilteredTargets: targets.length,
    page,
    pageCount,
    rangeStart: pageTargets.length === 0 ? 0 : start + 1,
    rangeEnd: start + pageTargets.length,
  };
}

/**
 * The single place correction URLs are built. Defaults are omitted rather than serialized, so the
 * unfiltered list stays at a clean `/corrections` and two equivalent views share one URL.
 */
export function buildCorrectionHref(
  query: CorrectionQuery,
  patch: Record<string, string | undefined>,
) {
  const merged: Record<string, string | undefined> = {
    q: query.search || undefined,
    page: query.page > 1 ? String(query.page) : undefined,
    ...patch,
  };

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }

  const search = params.toString();
  return search ? `/corrections?${search}` : "/corrections";
}
