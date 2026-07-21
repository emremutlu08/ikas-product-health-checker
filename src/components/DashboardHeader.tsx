/**
 * Dashboard header: who this is, what it last did, and the one operation that costs anything.
 *
 * Everything shown here comes from data the server already trusts — the sealed installation
 * session and the stored snapshot. Plan state is deliberately absent: the dashboard read path
 * resolves no entitlement, so any tier shown here would be a guess about the merchant's
 * billing state, and a plan-management link would have to be invented. That belongs with the
 * entitlement wiring, not here.
 */

const SCAN_ENDPOINT = "/api/scans";

export type DashboardHeaderProps = {
  storeName?: string;
  /** Timestamp of the last successful scan. Undefined before the first one. */
  generatedAt?: string;
  stale: boolean;
  /** Undefined when there is no snapshot to export. */
  csvHref?: string;
  /** True when the last scan attempt was refused because one was already running. */
  scanBusy: boolean;
};

function formatScanTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function DashboardHeader({
  storeName,
  generatedAt,
  stale,
  csvHref,
  scanBusy,
}: DashboardHeaderProps) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="text-title font-semibold tracking-tight text-text">Ürün Sağlığı</h1>
        {storeName ? (
          <p className="text-sm text-text-muted">
            Mağaza: <span className="font-medium text-text">{storeName}</span>
          </p>
        ) : null}
        <p className="text-sm text-text-muted">
          {generatedAt ? (
            <>
              Son tarama:{" "}
              <time className="font-medium text-text" dateTime={generatedAt}>
                {formatScanTime(generatedAt)}
              </time>
            </>
          ) : (
            "Henüz tarama yapılmadı."
          )}
        </p>
        {stale && generatedAt ? (
          <p className="text-sm font-medium text-warning">
            Bu rapor güncelliğini yitirmiş olabilir. Yeni bir tarama başlatın.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {csvHref ? (
          <a
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
            download="urun-sagligi-raporu.csv"
            href={csvHref}
          >
            CSV indir
          </a>
        ) : null}

        {/*
          A plain form POST, so the tenant is resolved from the sealed session and nothing
          tenant-identifying is submitted. While a scan is known to be running the control is
          disabled and relabelled rather than left to fail again on the server's 409.
        */}
        <form action={SCAN_ENDPOINT} method="post">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong"
            disabled={scanBusy}
            type="submit"
          >
            {scanBusy ? "Tarama sürüyor" : "Şimdi tara"}
          </button>
        </form>
      </div>
    </header>
  );
}
