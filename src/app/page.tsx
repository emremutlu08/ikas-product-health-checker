import { DashboardHeader } from "@/components/DashboardHeader";
import { HealthSummary } from "@/components/HealthSummary";
import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { ProductIssueTable } from "@/components/ProductIssueTable";
import { RuleFilters } from "@/components/RuleFilters";
import { assessHealth } from "@/lib/health/health-model";
import {
  buildProductIssueRows,
  parseProductTableQuery,
  selectProductTableRows,
  type ProductTableQuery,
} from "@/lib/dashboard/product-table";
import { getLatestProductHealthReport } from "@/lib/ikas/report-service";
import { isScanRunning } from "@/lib/scans/scan-service";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import type { HealthReport, MistakeRuleCode } from "@/lib/ikas/types";
import { getIkasLaunchAuthenticationHref } from "@/lib/ikas/installation-auth";
import { getSession, readInstallationSession } from "@/lib/session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const SCAN_OUTCOMES = ["completed", "busy", "limit", "failed"] as const;
type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

type SearchParams = Record<string, string | string[] | undefined>;

function readScanOutcome(value: unknown): ScanOutcome | undefined {
  return typeof value === "string" && (SCAN_OUTCOMES as readonly string[]).includes(value)
    ? (value as ScanOutcome)
    : undefined;
}

function authorizeStoreHref(storeName?: string) {
  const params = new URLSearchParams();
  if (storeName) params.set("storeName", storeName);
  const query = params.toString();
  return query ? `/authorize-store?${query}` : "/authorize-store";
}

/**
 * The single place dashboard URLs are built.
 *
 * Every control on the page — rule filters, sort, pagination, clear actions — is a link back
 * to this same route with a different query, so table state survives reloads and the back
 * button. Defaults are omitted rather than serialized, which keeps the unfiltered dashboard
 * at a clean `/` and makes two equivalent views share one URL.
 */
function buildDashboardHref(query: ProductTableQuery, patch: Record<string, string | undefined>) {
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

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const launchAuthenticationHref = getIkasLaunchAuthenticationHref(params);
  if (launchAuthenticationHref) redirect(launchAuthenticationHref);

  const installation = readInstallationSession(await getSession());
  const effectiveStoreName = installation?.storeName;
  const scanOutcome = readScanOutcome(params.scan);

  if (!installation) {
    return <SetupRequiredScreen storeName={effectiveStoreName} />;
  }

  // Reading the dashboard is a snapshot read. It never calls the ikas catalog and never
  // starts a scan; only the explicit `Şimdi tara` action does that.
  let result: Awaited<ReturnType<typeof getLatestProductHealthReport>>;
  try {
    result = await getLatestProductHealthReport(installation);
  } catch (error) {
    if (error instanceof IkasAuthenticationError) {
      return <SetupRequiredScreen expired storeName={effectiveStoreName} />;
    }
    throw error;
  }

  /**
   * The real answer to "is a scan running", read from the lease rather than inferred from the
   * URL. `?scan=busy` survives exactly one render — a reload drops it — so on its own it would
   * re-enable the button underneath a scan that is still going. Either signal disables the
   * control; the server's 409 remains the thing that actually prevents a duplicate.
   */
  const scanRunning = (await isScanRunning(installation)) || scanOutcome === "busy";

  if (result.source === "none") {
    return (
      <FirstScanScreen
        scanOutcome={scanOutcome}
        scanRunning={scanRunning}
        storeName={effectiveStoreName}
      />
    );
  }

  const { snapshot, stale } = result;
  const report = snapshot.report;

  // Everything below is a pure projection of the snapshot above.
  const query = parseProductTableQuery(params);
  const allRows = buildProductIssueRows(report);
  const selection = selectProductTableRows(allRows, query);
  const assessment = assessHealth(report);
  const interestRecorded = params.interest === "recorded";

  const hrefForRule = (rule?: MistakeRuleCode) =>
    // Changing the filter always returns to the first page: page 3 of the old filter is
    // rarely a meaningful position in the new one.
    buildDashboardHref(query, { rule, page: undefined });

  return (
    <main className="min-h-screen bg-canvas text-text">
      <IkasAppBridgeReady />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <DashboardHeader
          csvHref="/api/report.csv"
          generatedAt={snapshot.generatedAt}
          scanBusy={scanRunning}
          stale={stale}
          storeName={effectiveStoreName}
        />

        <ScanOutcomeNotice hasSnapshot outcome={scanOutcome} />

        <HealthSummary assessment={assessment} />

        <RuleFilters
          hrefForRule={hrefForRule}
          selectedRule={query.rule}
          summaries={report.ruleSummaries}
        />

        <ProductIssueTable
          buildHref={(patch) => buildDashboardHref(query, patch)}
          productCount={report.productCount}
          query={query}
          selection={selection}
          storeName={effectiveStoreName}
          totalAffectedProducts={allRows.length}
        />

        <LowStockInterestSection interestRecorded={interestRecorded} report={report} />
      </div>
    </main>
  );
}

/** Mirrors the header's scan control, including its lease-driven disabled state. */
function ScanNowButton({ scanRunning = false }: { scanRunning?: boolean }) {
  return (
    <form action="/api/scans" method="post">
      <button
        className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong"
        disabled={scanRunning}
        type="submit"
      >
        {scanRunning ? "Tarama sürüyor" : "Şimdi tara"}
      </button>
    </form>
  );
}

/**
 * Scan feedback is derived from an allowlisted status value, never from upstream text.
 * When a previous snapshot exists the copy says so explicitly, because a failed scan
 * leaves that snapshot in place rather than replacing it.
 */
function ScanOutcomeNotice({ outcome, hasSnapshot }: { outcome?: ScanOutcome; hasSnapshot: boolean }) {
  if (!outcome) return null;

  const previousReportNote = hasSnapshot
    ? " Aşağıdaki rapor son başarılı taramadan geliyor."
    : "";

  const notices: Record<ScanOutcome, { tone: string; text: string }> = {
    completed: {
      tone: "border-success bg-success-surface text-success",
      text: "Tarama tamamlandı. Rapor bu taramanın sonucunu gösteriyor.",
    },
    busy: {
      tone: "border-border-strong bg-surface-sunken text-text",
      text: `Bu mağaza için bir tarama zaten sürüyor. Tamamlanmasını bekleyin.${previousReportNote}`,
    },
    limit: {
      tone: "border-warning bg-warning-surface text-warning",
      text: `Katalog bu taramanın güvenli sınırlarını aştı. Eksik veya kısmi bir rapor göstermiyoruz.${previousReportNote}`,
    },
    failed: {
      tone: "border-warning bg-warning-surface text-warning",
      text: `Tarama tamamlanamadı. Bir süre sonra yeniden deneyin.${previousReportNote}`,
    },
  };

  const notice = notices[outcome];

  return (
    <p className={`rounded-md border px-4 py-3 text-sm font-medium ${notice.tone}`} role="status">
      {notice.text}
    </p>
  );
}

function FirstScanScreen({
  scanOutcome,
  scanRunning = false,
  storeName,
}: {
  scanOutcome?: ScanOutcome;
  scanRunning?: boolean;
  storeName?: string;
}) {
  return (
    <main className="min-h-screen bg-canvas text-text">
      <IkasAppBridgeReady />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10 sm:px-6">
        <ScanOutcomeNotice hasSnapshot={false} outcome={scanOutcome} />
        <section className="w-full rounded-lg border border-border bg-surface p-6 shadow-card">
          <p className="text-label font-semibold uppercase text-accent">Ürün Sağlığı</p>
          <h1 className="mt-2 text-title font-semibold tracking-tight text-text">
            Henüz tarama yapılmadı
          </h1>
          <p className="mt-3 text-sm leading-6 text-text-muted">
            Mağazanız bağlı. İlk sağlık raporunuzu oluşturmak için bir tarama başlatın. Tarama
            yalnızca siz başlattığınızda çalışır; sayfayı açmak veya filtre değiştirmek tarama
            yapmaz.
          </p>
          <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4 text-sm leading-6 text-text">
            <p className="font-semibold">Yalnızca okuma</p>
            <p className="mt-1 text-text-muted">
              SKU, barkod, fiyat, görsel, tekrarlanan başlık ve stok kuralları kontrol edilir. Ürün
              veya stok bilgileri değiştirilmez.
            </p>
          </div>
          {storeName ? <p className="mt-4 text-sm text-text-muted">Mağaza: {storeName}</p> : null}
          <div className="mt-5">
            <ScanNowButton scanRunning={scanRunning} />
          </div>
        </section>
      </div>
    </main>
  );
}

function SetupRequiredScreen({ expired = false, storeName }: { expired?: boolean; storeName?: string }) {
  const setupHref = authorizeStoreHref(storeName);

  return (
    <main className="min-h-screen bg-canvas text-text">
      <IkasAppBridgeReady />
      <div className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-10 sm:px-6">
        <section className="w-full rounded-lg border border-border bg-surface p-6 shadow-card">
          <p className="text-label font-semibold uppercase text-accent">Ürün Sağlığı</p>
          <h1 className="mt-2 text-title font-semibold tracking-tight text-text">
            {expired ? "Mağaza bağlantısını yenile" : "Kurulumu tamamla"}
          </h1>
          <p className="mt-3 text-sm leading-6 text-text-muted">
            Mağazanı bağlayarak SKU, barkod, fiyat, görsel ve stok sorunlarını tek raporda gör.
            Uygulama yalnızca ürün ve stok bilgilerini okur.
          </p>
          <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4 text-sm leading-6 text-text">
            <p className="font-semibold">Güvenli ve salt okunur</p>
            <p className="mt-1 text-text-muted">
              Ürün veya stok bilgileri değiştirilmez. Yetkilendirmeyi ikas ekranında onaylarsın ve
              bağlantıdan sonra ilk sağlık raporun açılır.
            </p>
          </div>
          {storeName ? (
            <p className="mt-4 text-sm text-text-muted">Algılanan mağaza adı: {storeName}</p>
          ) : null}
          <div className="mt-5">
            <a
              className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover sm:w-auto"
              href={setupHref}
            >
              {expired ? "Bağlantıyı güvenli şekilde yenile" : "ikas ile güvenli şekilde bağlan"}
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * The low-stock interest signal, written for a merchant rather than for a backlog.
 *
 * Three things have to stay true in this copy. The heading count is the hard blocked-sale
 * count the scan measures — fully out-of-stock variants with out-of-stock selling off — and
 * not a low-stock threshold, which nothing here computes. Threshold tracking is not running,
 * so the text says it is unavailable rather than describing when it might ship. And the app
 * only reads, which is stated as a promise about the merchant's data, not as a release scope.
 */
function LowStockInterestSection({
  interestRecorded,
  report,
}: {
  interestRecorded: boolean;
  report: HealthReport;
}) {
  return (
    <section
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
      id="low-stock-cta"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-title font-semibold text-text">
            {report.outOfStockBlockedCount} varyantta stok tükenmiş ve stok dışı satış kapalı
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
            Düşük stok uyarısı henüz kullanılamıyor. Yukarıdaki sayı, belirlediğiniz bir stok
            eşiğine göre değil; yalnızca stoğu tamamen bitmiş ve stok dışı satışı kapalı olduğu
            için satılamayan varyantlara göre hesaplanır. Stok ve ürün bilgileriniz
            değiştirilmez.
          </p>
        </div>
        {interestRecorded ? (
          <p className="rounded-md border border-success bg-success-surface px-4 py-3 text-sm font-medium text-success">
            İlginizi kaydettik. Düşük stok uyarısı kullanıma açıldığında size haber vereceğiz.
          </p>
        ) : (
          <form action="/api/interest" method="post">
            <input name="intent" type="hidden" value="low_stock_threshold_monitoring" />
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
              type="submit"
            >
              İlgimi çekti
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
