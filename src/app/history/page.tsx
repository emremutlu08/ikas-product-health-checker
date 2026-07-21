import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import {
  getProductHealthHistory,
  HistoryAccessError,
  type ProductHealthHistoryEntry,
} from "@/lib/billing/history-service";
import { SnapshotStoreError } from "@/lib/scans/snapshot-store";
import { getSession, readInstallationSession } from "@/lib/session";

function formatDate(value: string) {
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

function StateScreen({ title, description }: { title: string; description: string }) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10 text-text">
      <IkasAppBridgeReady />
      <section className="mx-auto max-w-2xl rounded-xl border border-border bg-surface p-6 shadow-card">
        <h1 className="text-title font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-text-muted">{description}</p>
        <a
          className="mt-5 inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
          href="/"
        >
          Ürün Sağlığına dön
        </a>
      </section>
    </main>
  );
}

function ChangeSummary({ entry }: { entry: ProductHealthHistoryEntry }) {
  if (entry.changes.baseline === "missing") {
    return <p className="mt-4 text-sm text-text-muted">Karşılaştırma için önceki tarama yok.</p>;
  }

  const changes = [
    { label: "Yeni sorun", value: entry.changes.added, tone: "text-critical" },
    { label: "Devam eden", value: entry.changes.ongoing, tone: "text-warning" },
    { label: "Çözülen", value: entry.changes.resolved, tone: "text-success" },
  ];

  return (
    <dl
      aria-label={`${entry.scanId} tarama değişimleri`}
      className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {changes.map((change) => (
        <div className="rounded-lg bg-surface-sunken p-3" key={change.label}>
          <dt className="text-label font-semibold uppercase text-text-muted">{change.label}</dt>
          <dd className={`mt-1 text-metric font-semibold ${change.tone}`}>{change.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function HistoryPage() {
  const installation = readInstallationSession(await getSession());
  if (!installation) {
    return (
      <StateScreen
        title="Tarama geçmişi açılamadı"
        description="Bu sayfayı ikas mağazanızla açın ve uygulama bağlantısını yeniden doğrulayın."
      />
    );
  }

  let history;
  try {
    history = await getProductHealthHistory(installation);
  } catch (error) {
    if (error instanceof HistoryAccessError) {
      return (
        <StateScreen
          title="Tarama geçmişi Pro özelliğidir"
          description="Geçmiş ve taramalar arası değişim özeti yalnız doğrulanmış aktif Pro aboneliklerde kullanılabilir."
        />
      );
    }
    if (error instanceof SnapshotStoreError) {
      return (
        <StateScreen
          title="Geçmiş şu anda yüklenemiyor"
          description="Kayıtlarınıza şu anda erişilemiyor. Bir süre sonra yeniden deneyin."
        />
      );
    }
    throw error;
  }

  return (
    <main className="min-h-screen bg-canvas text-text">
      <IkasAppBridgeReady />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-title font-semibold tracking-tight">Tarama Geçmişi</h1>
            <p className="mt-1 text-sm text-text-muted">Plan: Pro</p>
          </div>
          <a
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
            href="/"
          >
            Ürün Sağlığına dön
          </a>
        </header>

        {history.entries.length === 0 ? (
          <section className="rounded-xl border border-border bg-surface p-6 shadow-card">
            <h2 className="font-semibold">Henüz geçmiş kaydı yok</h2>
            <p className="mt-2 text-sm leading-6 text-text-muted">
              Pro doğrulamasından sonra tamamlanan başarılı taramalar burada karşılaştırılır.
            </p>
          </section>
        ) : (
          <ol aria-label="Tarama geçmişi" className="flex flex-col gap-4">
            {history.entries.map((entry) => (
              <li className="rounded-xl border border-border bg-surface p-5 shadow-card" key={entry.scanId}>
                <article aria-labelledby={`history-${entry.scanId}`}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h2 className="font-semibold" id={`history-${entry.scanId}`}>
                        <time dateTime={entry.generatedAt}>{formatDate(entry.generatedAt)}</time>
                      </h2>
                      <p className="mt-1 font-mono text-xs text-text-muted">{entry.scanId}</p>
                    </div>
                    <div className="rounded-full bg-accent-soft px-3 py-1 text-sm font-semibold text-accent">
                      {entry.health.score === null ? "Puan yok" : `${entry.health.score}/100`} · {entry.health.label}
                    </div>
                  </div>

                  <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                    <div><dt className="inline text-text-muted">Ürün: </dt><dd className="inline font-medium">{entry.productCount}</dd></div>
                    <div><dt className="inline text-text-muted">Sorunlu ürün: </dt><dd className="inline font-medium">{entry.affectedProductCount}</dd></div>
                    <div><dt className="inline text-text-muted">Toplam sorun: </dt><dd className="inline font-medium">{entry.issueCount}</dd></div>
                  </dl>

                  <ChangeSummary entry={entry} />
                </article>
              </li>
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}
