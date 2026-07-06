import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { getSession } from "@/lib/session";
import { getIkasToken } from "@/lib/ikas/token-store";
import { redirect } from "next/navigation";
import { getProductHealthReport } from "@/lib/ikas/report-service";
import { ProductImagePreview } from "@/components/ProductImagePreview";
import type { MistakeRuleCode } from "@/lib/ikas/types";

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

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ storeName?: string; authorizedAppId?: string; oauth?: string; rule?: MistakeRuleCode }>;
}) {
  const params = (await searchParams) ?? {};
  const session = await getSession().catch(() => undefined);
  const storedToken = await getIkasToken(params.authorizedAppId);

  if (!storedToken?.accessToken && params.authorizedAppId && params.storeName && params.oauth !== "skip") {
    redirect(`/api/oauth/authorize/ikas?storeName=${encodeURIComponent(params.storeName)}`);
  }

  if (!storedToken?.accessToken && !session?.accessToken && params.storeName && params.oauth !== "skip") {
    redirect(`/api/oauth/authorize/ikas?storeName=${encodeURIComponent(params.storeName)}`);
  }

  let reportResult: Awaited<ReturnType<typeof getProductHealthReport>>;
  try {
    reportResult = await getProductHealthReport(new Date(), params.authorizedAppId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (params.storeName && message.includes("LOGIN_REQUIRED") && params.oauth !== "skip") {
      redirect(`/api/oauth/authorize/ikas?storeName=${encodeURIComponent(params.storeName)}`);
    }
    throw error;
  }

  const { report, source } = reportResult;
  const isLive = source === "http";
  const selectedRule = params.rule;
  const csvHref = params.authorizedAppId ? `/api/report.csv?authorizedAppId=${encodeURIComponent(params.authorizedAppId)}` : "/api/report.csv";
  const selectedRuleLabel = selectedRule ? report.ruleSummaries.find((rule) => rule.code === selectedRule)?.label : undefined;
  const productRows = selectedRuleLabel
    ? report.productRows.filter((row) => row.mistakes.includes(selectedRuleLabel))
    : report.productRows;
  const launchQuery = new URLSearchParams();
  if (params.storeName) launchQuery.set("storeName", params.storeName);
  if (params.authorizedAppId) launchQuery.set("authorizedAppId", params.authorizedAppId);
  launchQuery.set("oauth", "skip");
  const baseDashboardHref = `/?${launchQuery.toString()}`;
  const scanStatus = report.scanStatus === "success" ? "Success" : "Queued";
  const lowStockIntentHref = `mailto:mutluemre93@gmail.com?subject=${encodeURIComponent("Low Stock Alert ilgimi çekti")}&body=${encodeURIComponent(
    `Store: ${params.storeName ?? "unknown"}\nCurrent low stock risks: ${report.lowStockRiskCount}\nAuthorized app: ${params.authorizedAppId ?? "unknown"}`,
  )}`;

  return (
    <main className="min-h-screen bg-[#f6f6f7] text-[#202223]">
      <IkasAppBridgeReady />
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-lg font-black text-emerald-300">P</div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">ikas admin app MVP</p>
              <h1 className="text-3xl font-bold tracking-tight text-slate-950">Product Data Health Checker</h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full px-3 py-1 text-sm font-semibold ring-1 ${isLive ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"}`}>
              {isLive ? "Live ikas GraphQL" : "Mock fallback"}
            </span>
            {params.storeName ? <span className="rounded-full bg-white px-3 py-1 text-sm text-slate-600 ring-1 ring-slate-200">Store: {params.storeName}</span> : null}
          </div>
        </header>

        <section className="rounded-3xl bg-blue-50 px-6 py-5 ring-1 ring-blue-100 md:flex md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-700">Find product data mistakes before they cost sales.</h2>
            <p className="mt-1 text-slate-600">SKU, barcode, price, image, duplicate title, duplicate SKU and stock rules are checked in read-only mode.</p>
            <a href="#low-stock-cta" className="mt-3 inline-flex text-sm font-bold text-blue-600">Low Stock Alert interest</a>
          </div>
          <div className="mt-4 flex text-5xl text-amber-300 md:mt-0" aria-hidden>
            ☆☆☆☆☆
          </div>
        </section>

        <section className="rounded-3xl bg-white p-7 shadow-sm ring-1 ring-slate-200">
          <div className="grid gap-6 lg:grid-cols-2">
            <SummaryItem icon="⬢" iconClass="bg-orange-50 text-orange-500" title="Total product(variants) in store" value={`${report.productCount} (${report.variantCount})`} />
            <SummaryItem icon="!" iconClass="bg-emerald-50 text-emerald-600" title="Total affected products" value={report.affectedProductCount} />
            <SummaryItem icon="▣" iconClass="bg-blue-50 text-blue-600" title={`Last scanned (${formatDate(report.generatedAt)})`} value={scanStatus} />
            <SummaryItem icon="✓" iconClass="bg-slate-100 text-slate-700" title="Health score" value={`${report.score}/100`} />
          </div>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-slate-950">Rules that watch over your store</h2>
              <p className="mt-1 text-sm text-slate-500">Click a rule to filter affected products. All checks are read-only.</p>
            </div>
            <a className="rounded-xl bg-orange-500 px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-orange-600" href={baseDashboardHref}>
              Apply Filter
            </a>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {report.ruleSummaries.map((rule) => {
              const active = selectedRule === rule.code;
              return (
                <a
                  key={rule.code}
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
                  <span className={`absolute -right-3 -top-3 flex h-10 min-w-10 items-center justify-center rounded-full px-2 text-sm font-black text-white ${rule.count === 0 ? "bg-emerald-600" : "bg-red-600"}`}>
                    {rule.count}
                  </span>
                </a>
              );
            })}
          </div>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-slate-950">Display published products only with rules selected above</h2>
              <p className="mt-1 text-sm text-slate-500">
                {selectedRuleLabel ? `${selectedRuleLabel} filtresi açık.` : "Tüm seçili rule sonuçları gösteriliyor."}
              </p>
            </div>
            <a download="ikas-product-health-report.csv" href={csvHref} className="rounded-xl bg-orange-500 px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-orange-600">
              Download CSV
            </a>
          </div>

          <div className="mt-6 overflow-hidden rounded-2xl ring-1 ring-slate-200">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-4">Image</th>
                  <th className="px-4 py-4">Title</th>
                  <th className="px-4 py-4">Errors/Mistakes</th>
                  <th className="px-4 py-4">Updated At</th>
                  <th className="px-4 py-4">Action</th>
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
                        <a className="font-semibold text-violet-600 hover:text-violet-800" href={params.storeName ? `https://${params.storeName}.myikas.com/admin/product/edit/${row.productId}` : `#${row.productId}`} target="_blank" rel="noreferrer">Review</a>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-6 py-10 text-center text-lg font-semibold text-slate-700">
                      Currently, there are no products matching this rule. Try updating or select a different rule.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section id="low-stock-cta" className="rounded-3xl bg-slate-950 p-7 text-white shadow-sm">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-emerald-300">Paid MVP hook</p>
              <h2 className="mt-2 text-2xl font-bold">{report.lowStockRiskCount} out-of-stock risk found</h2>
              <p className="mt-2 max-w-3xl text-slate-300">
                Next paid slice: daily low-stock summary, threshold-based alerts, and email/Slack notification. No stock or product mutation in V1.
              </p>
            </div>
            <a className="rounded-full bg-white px-5 py-3 text-center text-sm font-bold text-slate-950 transition hover:bg-emerald-100" href={lowStockIntentHref}>
              I’m interested
            </a>
          </div>
        </section>
      </section>
    </main>
  );
}

function SummaryItem({ icon, iconClass, title, value }: { icon: string; iconClass: string; title: string; value: string | number }) {
  return (
    <div className="flex items-center gap-5">
      <div className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-full text-3xl font-black ${iconClass}`}>{icon}</div>
      <div>
        <p className="text-lg font-semibold text-slate-600">{title}</p>
        <p className="mt-2 text-3xl font-black text-slate-950">{value}</p>
      </div>
    </div>
  );
}
