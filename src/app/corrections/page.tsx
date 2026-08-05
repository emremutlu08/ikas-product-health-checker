import { CorrectionPanel, type CorrectableTarget } from "@/components/CorrectionPanel";
import {
  buildCorrectionHref,
  parseCorrectionQuery,
  selectCorrections,
} from "@/lib/mutations/correction-list";
import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { resolveCapabilityMatrix } from "@/lib/billing/capability-catalog";
import { resolveRolloutSignals } from "@/lib/billing/rollout-signals";
import { resolveInstallationEntitlement } from "@/lib/billing/runtime-entitlement";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import { getLatestProductHealthReport } from "@/lib/ikas/report-service";
import { CORRECTABLE_ISSUE_KIND } from "@/lib/mutations/correction-messages";
import { getSession, readInstallationSession } from "@/lib/session";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * The correction surface.
 *
 * It renders controls only when the merchant could actually complete the write: an active Pro
 * grant *and* an operator who has opened the production flag after the development-store canary.
 * In every other case it explains the real state instead of offering a control that would be
 * refused, which is also what keeps the screen honest while the canary is still pending.
 */
function StateScreen({
  title,
  description,
  storeName,
}: {
  title: string;
  description: string;
  storeName?: string;
}) {
  return (
    <Shell storeName={storeName}>
      <section className="rounded-xl border border-border bg-surface p-6 shadow-card">
        <h2 className="text-title font-semibold text-text">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-text-muted">{description}</p>
        <Link
          className="mt-5 inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
          href="/plan"
        >
          Plan ve yetenekler
        </Link>
      </section>
    </Shell>
  );
}

function Shell({ children, storeName }: { children: React.ReactNode; storeName?: string }) {
  return (
    <main className="min-h-screen bg-canvas text-text">
      <IkasAppBridgeReady />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-title font-semibold tracking-tight">Güvenli düzeltmeler</h1>
            {storeName ? <p className="mt-1 text-sm text-text-muted">Mağaza: {storeName}</p> : null}
          </div>
          <nav aria-label="Ana navigasyon" className="flex flex-wrap gap-2">
            <Link
              className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium"
              href="/"
            >
              Ürün Sağlığı
            </Link>
            <Link
              className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium"
              href="/plan"
            >
              Plan
            </Link>
          </nav>
        </header>
        {children}
      </div>
    </main>
  );
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CorrectionsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const installation = readInstallationSession(await getSession());
  if (!installation) {
    return (
      <StateScreen
        title="Düzeltmeler açılamadı"
        description="Bu sayfayı ikas mağazanızla açın ve uygulama bağlantısını yeniden doğrulayın."
      />
    );
  }

  const entitlement = await resolveInstallationEntitlement(installation);
  const matrix = resolveCapabilityMatrix(entitlement, resolveRolloutSignals(installation));
  const capability = matrix.capabilities.find(
    (row) => row.feature === "product-corrections-write",
  )!;

  if (!capability.usableNow) {
    const description = !capability.includedInPlan
      ? "Güvenli tekil düzeltme PRO paketine dahildir. Mevcut planınızda bu yüzey kapalıdır."
      : capability.rollout === "development_store_only"
        ? "Bu yetenek şu anda yalnızca geliştirme mağazasıyla sınırlıdır. Geri alınabilir canary doğrulaması tamamlanana kadar üretimde açılmaz; kataloğunuzda hiçbir değişiklik yapılamaz."
        : "Bu yetenek şu anda kapalı. Kurulum tamamlandığında burada görünecek.";
    return (
      <StateScreen
        description={description}
        storeName={installation.storeName}
        title={`Düzeltmeler şu anda kullanılamıyor — ${capability.statusLabel}`}
      />
    );
  }

  let snapshot;
  try {
    snapshot = await getLatestProductHealthReport(installation);
  } catch (error) {
    if (error instanceof IkasAuthenticationError) {
      return (
        <StateScreen
          description="Mağaza bağlantınızın süresi doldu. Uygulamayı ikas panelinden yeniden açın."
          title="Düzeltmeler açılamadı"
        />
      );
    }
    throw error;
  }

  if (snapshot.source === "none") {
    return (
      <StateScreen
        description="Önce bir tarama yapın; düzeltmeler yalnızca taramanın bulduğu sorunlar için önerilir."
        storeName={installation.storeName}
        title="Henüz tarama yapılmadı"
      />
    );
  }

  /**
   * Images come from the stored product rows rather than being fetched again: the scan already
   * resolved them, and a correction screen that re-read the catalog would contradict its own
   * promise that nothing happens until the merchant asks for a preview.
   */
  const imagesByProduct = new Map(
    snapshot.snapshot.report.productRows.map((row) => [
      row.productId,
      { imageLabel: row.imageLabel, imageSrc: row.imageSrc },
    ]),
  );

  const seen = new Set<string>();
  const targets: CorrectableTarget[] = [];
  for (const issue of snapshot.snapshot.report.issues) {
    const kind = CORRECTABLE_ISSUE_KIND[issue.code];
    if (!kind || !issue.variantId) continue;
    const key = `${issue.productId}:${issue.variantId}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const image = imagesByProduct.get(issue.productId);
    targets.push({
      productId: issue.productId,
      productName: issue.productName,
      variantId: issue.variantId,
      ...(issue.variantLabel ? { variantLabel: issue.variantLabel } : {}),
      kind,
      issueMessage: issue.message,
      currentValue: issue.value === undefined ? "" : String(issue.value),
      // Initials rather than a blank tile when the product carries no usable image.
      imageLabel: image?.imageLabel ?? issue.productName.slice(0, 2).toLocaleUpperCase("tr-TR"),
      ...(image?.imageSrc ? { imageSrc: image.imageSrc } : {}),
    });
  }

  // Search and pagination run here rather than in the browser, so one page of work crosses the
  // wire instead of the whole catalog's worth of correctable variants.
  const query = parseCorrectionQuery(params);
  const selection = selectCorrections(targets, query);

  return (
    <Shell storeName={installation.storeName}>
      <p className="rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm leading-6 text-text">
        Her düzeltme tek bir alanı değiştirir. Önce bir önizleme oluşturulur, değişiklik yalnızca
        açık onayınızdan sonra uygulanır, sonra ikas&apos;tan yeniden okunarak doğrulanır ve diğer
        alanların değişmediği kontrol edilir.
      </p>
      <CorrectionPanel
        buildHref={(patch) => buildCorrectionHref(query, patch)}
        query={query}
        selection={selection}
        targets={selection.targets}
      />
    </Shell>
  );
}
