import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { getSession } from "@/lib/session";
import { getIkasToken } from "@/lib/ikas/token-store";
import { redirect } from "next/navigation";
import { getProductHealthReport } from "@/lib/ikas/report-service";

const issueLabels: Record<string, string> = {
  missing_sku: "SKU eksik",
  missing_barcode: "Barkod eksik",
  duplicate_sku: "Duplicate SKU",
  duplicate_barcode: "Duplicate barkod",
  missing_image: "Görsel eksik",
  missing_description: "Açıklama eksik",
  missing_category: "Kategori eksik",
  missing_brand: "Brand eksik",
  missing_vendor: "Vendor eksik",
  zero_stock_blocked: "Stok riski",
  missing_price: "Fiyat eksik",
};

function severityClass(severity: string) {
  if (severity === "critical") return "bg-red-50 text-red-700 ring-red-200";
  if (severity === "warning") return "bg-amber-50 text-amber-700 ring-amber-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

export default async function Home({ searchParams }: { searchParams?: Promise<{ storeName?: string; authorizedAppId?: string; oauth?: string }> }) {
  const params = (await searchParams) ?? {};
  const session = await getSession().catch(() => undefined);
  const storedToken = await getIkasToken(params.authorizedAppId);

  if (!storedToken?.accessToken && !session?.accessToken && params.storeName && params.oauth !== "skip") {
    redirect(`/api/oauth/authorize/ikas?storeName=${encodeURIComponent(params.storeName)}`);
  }

  const { report, source } = await getProductHealthReport(new Date(), params.authorizedAppId);
  const isLive = source === "http";
  const csvHref = params.authorizedAppId ? `/api/report.csv?authorizedAppId=${encodeURIComponent(params.authorizedAppId)}` : "/api/report.csv";
  const topIssueCounts = Object.entries(report.issueCountsByCode).filter(([, count]) => count > 0);
  const hasProducts = report.productCount > 0;
  const hasIssues = report.issueCount > 0;
  const lowStockIntentHref = `mailto:mutluemre93@gmail.com?subject=${encodeURIComponent("Low Stock Alert ilgimi çekti")}&body=${encodeURIComponent(
    `Store: ${params.storeName ?? "unknown"}
Current low stock risks: ${report.lowStockRiskCount}
Authorized app: ${params.authorizedAppId ?? "unknown"}`,
  )}`;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <IkasAppBridgeReady />
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-10 lg:px-8">
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl shadow-black/30">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.3em] text-emerald-300">ikas admin app MVP</p>
              <h1 className="text-4xl font-bold tracking-tight text-white md:text-6xl">Product Data Health Checker</h1>
              <p className="mt-4 text-lg leading-8 text-slate-300">
                Ürün kataloğundaki SKU, barkod, görsel, açıklama, kategori, fiyat ve stok risklerini read-only tarar. V1 hedefi:
                merchant’a ücretsiz değer gösterip Low Stock Alert için paid intent toplamak.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className={`inline-flex rounded-full px-3 py-1 text-sm font-semibold ring-1 ${isLive ? "bg-emerald-400/15 text-emerald-200 ring-emerald-300/30" : "bg-amber-400/15 text-amber-200 ring-amber-300/30"}`}>
                  Data source: {isLive ? "live ikas GraphQL" : "mock fallback"}
                </span>
                {params.storeName ? <span className="inline-flex rounded-full bg-white/10 px-3 py-1 text-sm text-slate-300 ring-1 ring-white/10">Store: {params.storeName}</span> : null}
              </div>
            </div>
            <div className="flex gap-3">
              <a
                download="ikas-product-health-report.csv"
                href={csvHref}
                className="rounded-full bg-emerald-400 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-emerald-300"
              >
                CSV indir
              </a>
              <a
                href="#low-stock-cta"
                className="rounded-full border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Low Stock Alert ilgimi çekti
              </a>
            </div>
          </div>
        </div>

        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <Metric title="Health score" value={`${report.score}/100`} tone="emerald" />
          <Metric title="Ürün" value={report.productCount} />
          <Metric title="Aktif varyant" value={report.variantCount} />
          <Metric title="Toplam sorun" value={report.issueCount} tone="amber" />
          <Metric title="Kritik" value={report.criticalCount} tone="red" />
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.9fr_1.4fr]">
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6">
            <h2 className="text-xl font-semibold text-white">Sorun dağılımı</h2>
            <div className="mt-5 space-y-3">
              {topIssueCounts.length ? (
                topIssueCounts.map(([code, count]) => (
                  <div key={code} className="flex items-center justify-between rounded-2xl bg-slate-900/80 px-4 py-3 ring-1 ring-white/10">
                    <span className="text-sm text-slate-300">{issueLabels[code] ?? code}</span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-sm font-bold text-slate-950">{count}</span>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl bg-slate-900/80 px-4 py-5 text-sm leading-6 text-slate-300 ring-1 ring-white/10">
                  {hasProducts ? "Bu taramada sorun bulunmadı. Katalog şu an temiz görünüyor." : "Bu mağazada taranacak aktif ürün bulunamadı. Ürün eklenince rapor otomatik anlamlı hale gelir."}
                </div>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-3xl border border-white/10 bg-white text-slate-950">
            <div className="border-b border-slate-200 px-6 py-5">
              <h2 className="text-xl font-semibold">Issue table</h2>
              <p className="mt-1 text-sm text-slate-500">{isLive ? "Canlı ikas GraphQL verisiyle üretilen read-only rapor." : "Mock ikas dataset ile çalışan fallback rapor ekranı."}</p>
            </div>
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Severity</th>
                    <th className="px-4 py-3">Issue</th>
                    <th className="px-4 py-3">Ürün</th>
                    <th className="px-4 py-3">Varyant</th>
                    <th className="px-4 py-3">Mesaj</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {hasIssues ? (
                    report.issues.map((issue, index) => (
                      <tr key={`${issue.code}-${issue.productId}-${issue.variantId ?? "product"}-${index}`} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${severityClass(issue.severity)}`}>
                            {issue.severity}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium">{issueLabels[issue.code]}</td>
                        <td className="px-4 py-3">{issue.productName}</td>
                        <td className="px-4 py-3 text-slate-500">{issue.variantLabel ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-600">{issue.message}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500">
                        {hasProducts ? "Sorun bulunmadı. CSV export yine de rapor arşivi için kullanılabilir." : "Aktif ürün bulunamadı. ikas ürün kataloğuna ürün eklendiğinde bu tablo dolacak."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="low-stock-cta" className="rounded-3xl border border-emerald-300/30 bg-emerald-300/10 p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-emerald-200">Paid MVP hook</p>
              <h2 className="mt-2 text-2xl font-bold text-white">{report.lowStockRiskCount} stok riski bulundu</h2>
              <p className="mt-2 max-w-3xl text-slate-300">
                Faz 2 için ödeme veya cron eklemeden önce merchant intent ölçüyoruz. Bu buton şimdilik sadece talep toplama placeholder’ı;
                ürün, stok veya ödeme datasını değiştirmez.
              </p>
              <ul className="mt-4 grid gap-2 text-sm text-emerald-50/90 md:grid-cols-3">
                <li className="rounded-2xl bg-slate-950/40 px-3 py-2 ring-1 ring-white/10">Günlük stok özeti</li>
                <li className="rounded-2xl bg-slate-950/40 px-3 py-2 ring-1 ring-white/10">Eşik bazlı uyarı</li>
                <li className="rounded-2xl bg-slate-950/40 px-3 py-2 ring-1 ring-white/10">Email/Slack bildirimi</li>
              </ul>
            </div>
            <a className="rounded-full bg-white px-5 py-3 text-center text-sm font-bold text-slate-950 transition hover:bg-emerald-100" href={lowStockIntentHref}>
              İlgimi çekti
            </a>
          </div>
        </section>
      </section>
    </main>
  );
}

function Metric({ title, value, tone = "slate" }: { title: string; value: string | number; tone?: "slate" | "emerald" | "amber" | "red" }) {
  const tones = {
    slate: "text-white",
    emerald: "text-emerald-300",
    amber: "text-amber-300",
    red: "text-red-300",
  };

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
      <p className="text-sm text-slate-400">{title}</p>
      <p className={`mt-3 text-4xl font-bold ${tones[tone]}`}>{value}</p>
    </div>
  );
}
