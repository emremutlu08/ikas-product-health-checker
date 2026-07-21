import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { getLatestProductHealthReport } from "@/lib/ikas/report-service";
import { ProductImagePreview } from "@/components/ProductImagePreview";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import type { HealthReport, MistakeRuleCode } from "@/lib/ikas/types";
import { getIkasLaunchAuthenticationHref } from "@/lib/ikas/installation-auth";
import { getSession, readInstallationSession } from "@/lib/session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const SCAN_OUTCOMES = ["completed", "busy", "limit", "failed"] as const;
type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

function readScanOutcome(value: unknown): ScanOutcome | undefined {
  return typeof value === "string" && (SCAN_OUTCOMES as readonly string[]).includes(value)
    ? (value as ScanOutcome)
    : undefined;
}

function formatDate(value?: string) {
  if (!value) return "—";
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

function appendRuleToHref(baseHref: string, rule?: string) {
  if (!rule) return baseHref;
  return `${baseHref}${baseHref.includes("?") ? "&" : "?"}rule=${encodeURIComponent(rule)}`;
}

function authorizeStoreHref(storeName?: string) {
  const params = new URLSearchParams();
  if (storeName) params.set("storeName", storeName);
  const query = params.toString();
  return query ? `/authorize-store?${query}` : "/authorize-store";
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
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

  if (result.source === "none") {
    return <FirstScanScreen scanOutcome={scanOutcome} storeName={effectiveStoreName} />;
  }

  const { snapshot, stale } = result;
  const report = snapshot.report;
  const selectedRule = typeof params.rule === "string" ? (params.rule as MistakeRuleCode) : undefined;
  const csvHref = "/api/report.csv";
  const selectedRuleLabel = selectedRule
    ? report.ruleSummaries.find((rule) => rule.code === selectedRule)?.label
    : undefined;
  const productRows = selectedRuleLabel
    ? report.productRows.filter((row) => row.mistakes.includes(selectedRuleLabel))
    : report.productRows;
  const baseDashboardHref = "/";
  const interestRecorded = params.interest === "recorded";

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <IkasAppBridgeReady />
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-600 text-lg font-black text-white" aria-hidden="true">Ü</div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">Ürün veri denetimi</p>
              <h1 className="text-3xl font-bold tracking-tight text-slate-950">Ürün Sağlığı</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {effectiveStoreName ? <span className="rounded-full bg-white px-3 py-1 text-sm text-slate-600 ring-1 ring-slate-200">Mağaza: {effectiveStoreName}</span> : null}
            <ScanNowButton />
          </div>
        </header>

        <ScanOutcomeNotice outcome={scanOutcome} hasSnapshot />

        <section className="rounded-3xl bg-white px-6 py-5 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
            <p className="text-sm text-slate-600">
              Son tarama:{" "}
              <time className="font-semibold text-slate-900" dateTime={snapshot.generatedAt}>
                {formatDate(snapshot.generatedAt)}
              </time>
            </p>
            {stale ? (
              <p className="text-sm font-semibold text-amber-700">
                Bu rapor güncelliğini yitirmiş olabilir. Yeni bir tarama başlatın.
              </p>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-slate-500">
            Filtreler, tablo ve CSV bu taramanın sonucundan okunur; sayfayı gezmek yeni tarama başlatmaz.
          </p>
        </section>

        <section className="rounded-3xl bg-white p-7 shadow-sm ring-1 ring-slate-200">
          <div className="grid gap-6 lg:grid-cols-2">
            <SummaryItem title="Mağazadaki toplam ürün/varyant" value={`${report.productCount} (${report.variantCount})`} />
            <SummaryItem title="Sorunlu ürün sayısı" value={report.affectedProductCount} />
            <SummaryItem title="Kritik sorun sayısı" value={report.criticalCount} />
            <SummaryItem title="Sağlık skoru" value={`${report.score}/100`} />
          </div>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-slate-950">Mağazanızı kontrol eden kurallar</h2>
              <p className="mt-1 text-sm text-slate-500">Etkilenen ürünleri filtrelemek için bir kurala tıklayın. Tüm kontroller yalnızca okuma modundadır.</p>
            </div>
            {selectedRuleLabel ? (
              <a className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-center text-sm font-bold text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600" href={baseDashboardHref}>
                Filtreyi temizle
              </a>
            ) : null}
          </div>

          <nav aria-label="Kural filtresi" className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {report.ruleSummaries.map((rule) => {
              const active = selectedRule === rule.code;
              return (
                <a
                  key={rule.code}
                  aria-current={active ? "page" : undefined}
                  aria-label={`${rule.label}, ${rule.count} ürün`}
                  className={`relative flex min-h-20 items-center justify-center rounded-2xl px-5 py-4 text-center text-lg font-bold ring-1 transition ${
                    active
                      ? "border-orange-500 bg-orange-50 text-orange-700 ring-orange-400"
                      : rule.count === 0
                        ? "bg-emerald-50 text-emerald-800 ring-emerald-200 hover:bg-emerald-100"
                        : "bg-slate-100 text-slate-950 ring-slate-300 hover:bg-orange-50"
                  }`}
                  href={appendRuleToHref(baseDashboardHref, rule.code)}
                >
                  {rule.label}
                  {active ? <span className="ml-2 text-xs font-semibold">Seçili</span> : null}
                  <span aria-hidden="true" className={`absolute -right-2 -top-2 flex h-9 min-w-9 items-center justify-center rounded-full px-2 text-sm font-black text-white ${rule.count === 0 ? "bg-emerald-600" : "bg-red-600"}`}>
                    {rule.count}
                  </span>
                </a>
              );
            })}
          </nav>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-slate-950">Yukarıdaki kurallara göre etkilenen ürünler</h2>
              <p className="mt-1 text-sm text-slate-500">
                {selectedRuleLabel ? `${selectedRuleLabel} filtresi açık.` : "Tüm seçili kural sonuçları gösteriliyor."}
              </p>
            </div>
            <a download="ikas-product-health-report.csv" href={csvHref} className="rounded-xl bg-orange-500 px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-orange-600">
              CSV indir
            </a>
          </div>

          <div className="mt-6 overflow-x-auto rounded-2xl ring-1 ring-slate-200" role="region" aria-label="Ürün sorunları tablosu" tabIndex={0}>
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-4">Görsel</th>
                  <th className="px-4 py-4">Ürün adı</th>
                  <th className="px-4 py-4">Hatalar/Eksikler</th>
                  <th className="px-4 py-4">Güncellenme tarihi</th>
                  <th className="px-4 py-4">İşlem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {productRows.length ? (
                  productRows.map((row) => (
                    <tr key={row.productId} className="hover:bg-slate-50">
                      <td className="px-4 py-4">
                        <ProductImagePreview alt={row.productName} label={row.imageLabel} src={row.imageSrc} />
                      </td>
                      <td className="px-4 py-4 font-semibold text-violet-600">{row.productName}</td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-2">
                          {row.mistakes.map((mistake) => (
                            <span key={mistake} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                              {mistake}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-slate-700">{formatDate(row.updatedAt)}</td>
                      <td className="px-4 py-4">
                        <a className="font-semibold text-violet-600 hover:text-violet-800" href={effectiveStoreName ? `https://${effectiveStoreName}.myikas.com/admin/product/edit/${row.productId}` : `#${row.productId}`} target="_blank" rel="noreferrer">İncele</a>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-6 py-10 text-center text-lg font-semibold text-slate-700">
                      Bu kurala uyan ürün yok. Farklı bir kural seçin veya ürünleri güncelleyin.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <LowStockInterestSection interestRecorded={interestRecorded} report={report} />
      </section>
    </main>
  );
}

function ScanNowButton({ label = "Şimdi tara" }: { label?: string }) {
  return (
    <form action="/api/scans" method="post">
      <button
        type="submit"
        className="inline-flex min-h-11 items-center justify-center rounded-xl bg-orange-600 px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
      >
        {label}
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
      tone: "bg-emerald-50 text-emerald-900 ring-emerald-200",
      text: "Tarama tamamlandı. Rapor bu taramanın sonucunu gösteriyor.",
    },
    busy: {
      tone: "bg-blue-50 text-blue-900 ring-blue-200",
      text: `Bu mağaza için bir tarama zaten sürüyor. Tamamlanmasını bekleyin.${previousReportNote}`,
    },
    limit: {
      tone: "bg-amber-50 text-amber-900 ring-amber-200",
      text: `Katalog bu taramanın güvenli sınırlarını aştı. Eksik veya kısmi bir rapor göstermiyoruz.${previousReportNote}`,
    },
    failed: {
      tone: "bg-amber-50 text-amber-900 ring-amber-200",
      text: `Tarama tamamlanamadı. Bir süre sonra yeniden deneyin.${previousReportNote}`,
    },
  };

  const notice = notices[outcome];

  return (
    <p role="status" className={`rounded-2xl px-5 py-4 text-sm font-semibold ring-1 ${notice.tone}`}>
      {notice.text}
    </p>
  );
}

function FirstScanScreen({
  scanOutcome,
  storeName,
}: {
  scanOutcome?: ScanOutcome;
  storeName?: string;
}) {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <IkasAppBridgeReady />
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-10 sm:px-6">
        <ScanOutcomeNotice outcome={scanOutcome} hasSnapshot={false} />
        <div className="w-full rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">Ürün Sağlığı</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Henüz tarama yapılmadı</h1>
          <p className="mt-3 text-base leading-7 text-slate-600">
            Mağazanız bağlı. İlk sağlık raporunuzu oluşturmak için bir tarama başlatın. Tarama
            yalnızca siz başlattığınızda çalışır; sayfayı açmak veya filtre değiştirmek tarama
            yapmaz.
          </p>
          <div className="mt-5 rounded-2xl bg-blue-50 p-4 text-sm leading-6 text-blue-950 ring-1 ring-blue-100">
            <p className="font-semibold">Yalnızca okuma</p>
            <p className="mt-1">
              SKU, barkod, fiyat, görsel, tekrarlanan başlık ve stok kuralları kontrol edilir. Ürün
              veya stok bilgileri değiştirilmez.
            </p>
          </div>
          {storeName ? <p className="mt-4 text-sm text-slate-500">Mağaza: {storeName}</p> : null}
          <div className="mt-6">
            <ScanNowButton label="Şimdi tara" />
          </div>
        </div>
      </section>
    </main>
  );
}

function SetupRequiredScreen({ expired = false, storeName }: { expired?: boolean; storeName?: string }) {
  const setupHref = authorizeStoreHref(storeName);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <IkasAppBridgeReady />
      <section className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-10 sm:px-6">
        <div className="w-full rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">Ürün Sağlığı</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">
            {expired ? "Mağaza bağlantısını yenile" : "Kurulumu tamamla"}
          </h1>
          <p className="mt-3 text-base leading-7 text-slate-600">
            Mağazanı bağlayarak SKU, barkod, fiyat, görsel ve stok sorunlarını tek raporda gör. Uygulama yalnızca ürün ve stok bilgilerini okur.
          </p>
          <div className="mt-5 rounded-2xl bg-blue-50 p-4 text-sm leading-6 text-blue-950 ring-1 ring-blue-100">
            <p className="font-semibold">Güvenli ve salt okunur</p>
            <p className="mt-1">Ürün veya stok bilgileri değiştirilmez. Yetkilendirmeyi ikas ekranında onaylarsın ve bağlantıdan sonra ilk sağlık raporun açılır.</p>
          </div>
          {storeName ? <p className="mt-4 text-sm text-slate-500">Algılanan mağaza adı: {storeName}</p> : null}
          <div className="mt-6">
            <a className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-orange-600 px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600 sm:w-auto" href={setupHref}>
              {expired ? "Bağlantıyı güvenli şekilde yenile" : "ikas ile güvenli şekilde bağlan"}
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

function LowStockInterestSection({
  interestRecorded,
  report,
}: {
  interestRecorded: boolean;
  report: HealthReport;
}) {
  return (
    <section id="low-stock-cta" className="rounded-3xl bg-slate-950 p-7 text-white shadow-sm">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-orange-200">Pro ile sürekli izleme</p>
          <h2 className="mt-2 text-2xl font-bold">
            {report.outOfStockBlockedCount} varyantta stok tükenmiş ve stok dışı satış kapalı
          </h2>
          <p className="mt-2 max-w-3xl text-slate-300">
            Planlanan ücretli özellik: kendi belirlediğiniz eşiğe göre düşük stok takibi, günlük özet ve bildirim.
            Bu eşik henüz ölçülmüyor; yukarıdaki sayı yalnızca tamamen stoksuz ve satışa kapalı varyantları gösterir.
            V1’de stok veya ürün güncellemesi yapılmaz.
          </p>
        </div>
        {interestRecorded ? (
          <p className="rounded-full bg-emerald-400/15 px-5 py-3 text-center text-sm font-bold text-emerald-200 ring-1 ring-emerald-400/40">
            İlginizi kaydettik. Eşik takibi yayına çıktığında haber vereceğiz.
          </p>
        ) : (
          <form action="/api/interest" method="post">
            <input type="hidden" name="intent" value="low_stock_threshold_monitoring" />
            <button
              type="submit"
              className="rounded-full bg-white px-5 py-3 text-center text-sm font-bold text-slate-950 transition hover:bg-emerald-100"
            >
              İlgimi çekti
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

function SummaryItem({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <p className="text-3xl font-black text-slate-950">{value}</p>
    </div>
  );
}
