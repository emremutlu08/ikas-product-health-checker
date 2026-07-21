import { ProductImagePreview } from "@/components/ProductImagePreview";
import {
  PRODUCT_TABLE_SORTS,
  SEVERITY_LABELS,
  SORT_LABELS,
  type ProductIssueRow,
  type ProductTableQuery,
  type ProductTableSelection,
  type ProductTableSort,
} from "@/lib/dashboard/product-table";
import { RULE_LABELS } from "@/lib/ikas/health-rules";
import type { HealthIssueSeverity } from "@/lib/ikas/types";

/**
 * The operational product table.
 *
 * Search, sort, filter and pagination are all URL state, so this component is a pure
 * projection of the stored snapshot and every control is a plain link or a GET form. Nothing
 * here can start a scan.
 *
 * At embedded widths the table scrolls horizontally inside a focusable region with a visible
 * hint. The product name itself is the link into ikas admin, so there is no trailing action
 * column that narrow viewports could clip off the right edge.
 */

export type ProductIssueTableProps = {
  selection: ProductTableSelection;
  query: ProductTableQuery;
  /** Products in the whole snapshot, used to tell an empty store from a healthy one. */
  productCount: number;
  /** Affected products before rule/search narrowing, for the same reason. */
  totalAffectedProducts: number;
  storeName?: string;
  buildHref(patch: Record<string, string | undefined>): string;
};

const SEVERITY_STYLES: Record<HealthIssueSeverity, string> = {
  critical: "bg-critical-surface text-critical",
  warning: "bg-warning-surface text-warning",
  info: "bg-surface-sunken text-text-muted",
};

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function adminHref(storeName: string | undefined, productId: string) {
  return storeName
    ? `https://${storeName}.myikas.com/admin/product/edit/${encodeURIComponent(productId)}`
    : undefined;
}

function EmptyState({
  query,
  productCount,
  totalAffectedProducts,
}: Pick<ProductIssueTableProps, "query" | "productCount" | "totalAffectedProducts">) {
  // Four genuinely different situations. Collapsing them into one message would tell a
  // merchant with a clean catalog the same thing as a merchant whose search missed.
  if (productCount === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-text-muted">
        Mağazanızda taranacak ürün bulunamadı. Ürün ekledikten sonra yeniden tarayın.
      </p>
    );
  }

  if (totalAffectedProducts === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-text-muted">
        Hiçbir kural sorun bulmadı. Taranan {productCount} üründe düzeltilecek bir şey yok.
      </p>
    );
  }

  if (query.search) {
    return (
      <p className="px-4 py-10 text-center text-sm text-text-muted">
        “{query.search}” aramasıyla eşleşen ürün yok. Aramayı temizleyip yeniden deneyin.
      </p>
    );
  }

  return (
    <p className="px-4 py-10 text-center text-sm text-text-muted">
      Bu kurala uyan ürün yok. Farklı bir kural seçin.
    </p>
  );
}

function ActiveNarrowing({ query }: { query: ProductTableQuery }) {
  const parts: string[] = [];
  if (query.rule) parts.push(`Filtre: ${RULE_LABELS[query.rule]}`);
  if (query.search) parts.push(`Arama: “${query.search}”`);
  parts.push(`Sıralama: ${SORT_LABELS[query.sort]}`);

  const narrowed = Boolean(query.rule || query.search);

  return (
    <p className="text-sm text-text-muted">
      {narrowed ? parts.join(" · ") : `Tüm sorunlu ürünler gösteriliyor · ${parts.at(-1)}`}
    </p>
  );
}

function SeveritySummary({ counts }: { counts: Record<HealthIssueSeverity, number> }) {
  return (
    <p className="flex flex-wrap gap-2 text-sm">
      {(Object.keys(SEVERITY_LABELS) as HealthIssueSeverity[]).map((severity) => (
        <span
          className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-medium ${SEVERITY_STYLES[severity]}`}
          key={severity}
        >
          {SEVERITY_LABELS[severity]}
          <span className="tabular-nums">{counts[severity]}</span>
        </span>
      ))}
    </p>
  );
}

function SortLinks({
  query,
  buildHref,
}: Pick<ProductIssueTableProps, "query" | "buildHref">) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-label font-medium uppercase text-text-muted">Sırala</span>
      {PRODUCT_TABLE_SORTS.map((sort: ProductTableSort) => {
        const active = query.sort === sort;
        return (
          <a
            aria-current={active ? "true" : undefined}
            className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm transition ${
              active
                ? "bg-accent-soft font-semibold text-accent"
                : "text-text-muted hover:bg-surface-sunken"
            }`}
            href={buildHref({ sort, page: undefined })}
            key={sort}
          >
            {SORT_LABELS[sort]}
          </a>
        );
      })}
    </div>
  );
}

function Pagination({
  selection,
  buildHref,
}: Pick<ProductIssueTableProps, "selection" | "buildHref">) {
  if (selection.pageCount <= 1) return null;

  const linkClass =
    "inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium text-text transition hover:bg-surface-sunken";
  const disabledClass =
    "inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm font-medium text-text-muted";

  return (
    <nav aria-label="Sayfalama" className="flex items-center justify-between gap-3 pt-4">
      <p className="text-sm text-text-muted tabular-nums">
        {selection.rangeStart}–{selection.rangeEnd} / {selection.totalRows} ürün
      </p>
      <div className="flex gap-2">
        {selection.page > 1 ? (
          <a className={linkClass} href={buildHref({ page: String(selection.page - 1) })}>
            Önceki
          </a>
        ) : (
          <span aria-disabled="true" className={disabledClass}>
            Önceki
          </span>
        )}
        {selection.page < selection.pageCount ? (
          <a className={linkClass} href={buildHref({ page: String(selection.page + 1) })}>
            Sonraki
          </a>
        ) : (
          <span aria-disabled="true" className={disabledClass}>
            Sonraki
          </span>
        )}
      </div>
    </nav>
  );
}

function ProductRow({ row, storeName }: { row: ProductIssueRow; storeName?: string }) {
  const href = adminHref(storeName, row.productId);

  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3">
        <ProductImagePreview alt={row.productName} label={row.imageLabel} src={row.imageSrc} />
      </td>
      <td className="px-4 py-3">
        {href ? (
          <a
            className="font-medium text-accent underline-offset-2 hover:underline"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            {row.productName}
          </a>
        ) : (
          <span className="font-medium text-text">{row.productName}</span>
        )}
      </td>
      <td className="px-4 py-3">
        {row.severity ? (
          <span
            className={`inline-flex rounded-sm px-2 py-0.5 text-sm font-medium ${SEVERITY_STYLES[row.severity]}`}
          >
            {SEVERITY_LABELS[row.severity]}
          </span>
        ) : (
          <span className="text-sm text-text-muted">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="flex flex-wrap gap-1">
          {row.mistakes.map((mistake) => (
            <span
              className="rounded-sm bg-surface-sunken px-2 py-0.5 text-sm text-text"
              key={mistake}
            >
              {mistake}
            </span>
          ))}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-text-muted tabular-nums">{formatDate(row.updatedAt)}</td>
    </tr>
  );
}

export function ProductIssueTable({
  selection,
  query,
  productCount,
  totalAffectedProducts,
  storeName,
  buildHref,
}: ProductIssueTableProps) {
  return (
    <section
      aria-labelledby="product-issues-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
    >
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-title font-semibold text-text" id="product-issues-heading">
            Sorunlu ürünler
          </h2>
          <ActiveNarrowing query={query} />
        </div>

        <SeveritySummary counts={selection.severityCounts} />

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/*
            A GET form, so the search term becomes shareable URL state. The active rule and
            sort ride along as hidden fields; page deliberately does not, because a new search
            should land on the first page of its own results.
          */}
          <form action="/" className="flex flex-wrap items-center gap-2" method="get">
            {query.rule ? <input name="rule" type="hidden" value={query.rule} /> : null}
            <input name="sort" type="hidden" value={query.sort} />
            <label className="text-label font-medium uppercase text-text-muted" htmlFor="product-search">
              Ürün ara
            </label>
            <input
              className="min-h-11 rounded-md border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-text-muted"
              defaultValue={query.search}
              id="product-search"
              name="q"
              placeholder="Ürün adı"
              type="search"
            />
            <button
              className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover"
              type="submit"
            >
              Ara
            </button>
            {query.search ? (
              <a
                className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
                href={buildHref({ q: undefined, page: undefined })}
              >
                Aramayı temizle
              </a>
            ) : null}
          </form>

          <SortLinks buildHref={buildHref} query={query} />
        </div>
      </div>

      {selection.rows.length === 0 ? (
        <EmptyState
          productCount={productCount}
          query={query}
          totalAffectedProducts={totalAffectedProducts}
        />
      ) : (
        <>
          <p className="mt-4 text-sm text-text-muted lg:hidden">
            Tabloyu yatay kaydırarak tüm sütunları görebilirsiniz.
          </p>
          <div
            aria-label="Ürün sorunları tablosu"
            className="mt-2 overflow-x-auto rounded-md border border-border"
            role="region"
            tabIndex={0}
          >
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead className="bg-surface-sunken">
                <tr>
                  <th className="px-4 py-3 text-label font-medium uppercase text-text-muted" scope="col">
                    Görsel
                  </th>
                  <th className="px-4 py-3 text-label font-medium uppercase text-text-muted" scope="col">
                    Ürün adı
                  </th>
                  <th className="px-4 py-3 text-label font-medium uppercase text-text-muted" scope="col">
                    Öncelik
                  </th>
                  <th className="px-4 py-3 text-label font-medium uppercase text-text-muted" scope="col">
                    Hatalar/Eksikler
                  </th>
                  <th className="px-4 py-3 text-label font-medium uppercase text-text-muted" scope="col">
                    Güncellenme
                  </th>
                </tr>
              </thead>
              <tbody>
                {selection.rows.map((row) => (
                  <ProductRow key={row.productId} row={row} storeName={storeName} />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination buildHref={buildHref} selection={selection} />
        </>
      )}
    </section>
  );
}
