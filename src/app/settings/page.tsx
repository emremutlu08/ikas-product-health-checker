import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { isDailySummaryEmailConfigured } from "@/lib/monitoring/email-summary";
import { resolveVerifiedRecipient } from "@/lib/monitoring/verified-recipient";
import {
  readMonitoringSettings,
  SettingsAccessError,
} from "@/lib/settings/settings-service";
import {
  MAX_LOW_STOCK_THRESHOLD,
  MIN_LOW_STOCK_THRESHOLD,
  MonitoringSettingsStoreError,
  type MonitoringSettings,
} from "@/lib/settings/settings-store";
import { getSession, readInstallationSession } from "@/lib/session";
import Link from "next/link";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
type SaveStatus = "saved" | "invalid" | "unavailable" | "error";

function readStatus(value: unknown): SaveStatus | undefined {
  return value === "saved" || value === "invalid" || value === "unavailable" || value === "error"
    ? value
    : undefined;
}

function StateScreen({ title, description }: { title: string; description: string }) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10 text-text">
      <IkasAppBridgeReady />
      <section className="mx-auto max-w-2xl rounded-xl border border-border bg-surface p-6 shadow-card">
        <h1 className="text-title font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-text-muted">{description}</p>
        <Link
          className="mt-5 inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
          href="/"
        >
          Ürün Sağlığına dön
        </Link>
      </section>
    </main>
  );
}

function StatusNotice({ status }: { status?: SaveStatus }) {
  if (!status) return null;
  const notices = {
    saved: { tone: "border-success bg-success-surface text-success", text: "Ayarlar kaydedildi." },
    invalid: {
      tone: "border-warning bg-warning-surface text-warning",
      text: "Ayarlar kaydedilemedi. Girdiğiniz değerleri kontrol edip yeniden deneyin.",
    },
    unavailable: {
      tone: "border-warning bg-warning-surface text-warning",
      text: "Günlük e-posta etkinleştirilemedi. Doğrulanmış alıcı ve otomatik tarama hazırlığını kontrol edin.",
    },
    error: {
      tone: "border-warning bg-warning-surface text-warning",
      text: "Ayarlar şu anda kaydedilemedi. Bir süre sonra yeniden deneyin.",
    },
  } satisfies Record<SaveStatus, { tone: string; text: string }>;
  const notice = notices[status];
  return (
    <p
      className={`rounded-md border px-4 py-3 text-sm font-medium ${notice.tone}`}
      role={status === "saved" ? "status" : "alert"}
    >
      {notice.text}
    </p>
  );
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "—";
  return `${local[0]}***${local.length > 1 ? local.at(-1) : ""}@${domain}`;
}

function SettingsForm({
  settings,
  schedulerEnabled,
  emailDeliveryConfigured,
  recipientEmail,
}: {
  settings: MonitoringSettings;
  schedulerEnabled: boolean;
  emailDeliveryConfigured: boolean;
  recipientEmail?: string;
}) {
  const emailReady = schedulerEnabled && emailDeliveryConfigured && Boolean(recipientEmail);
  return (
    <form action="/api/settings" className="flex flex-col gap-6" method="post">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-semibold text-text" htmlFor="lowStockThreshold">
          Düşük stok eşiği
        </label>
        <input
          aria-describedby="lowStockThreshold-help"
          className="min-h-11 w-full max-w-xs rounded-md border border-border-strong bg-surface px-3 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          defaultValue={settings.lowStockThreshold}
          id="lowStockThreshold"
          inputMode="numeric"
          max={MAX_LOW_STOCK_THRESHOLD}
          min={MIN_LOW_STOCK_THRESHOLD}
          name="lowStockThreshold"
          step={1}
          type="number"
        />
        <p className="text-sm leading-6 text-text-muted" id="lowStockThreshold-help">
          Stok adedi 1 ile bu değer arasında olan aktif varyantlar taramada düşük stok olarak
          işaretlenir. 0 girildiğinde düşük stok uyarısı kapalı olur. Stok bilgileriniz değiştirilmez.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <input
            aria-describedby="dailyEmailEnabled-help"
            className="size-5 rounded border-border-strong text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            defaultChecked={settings.dailyEmailEnabled}
            disabled={!emailReady && !settings.dailyEmailEnabled}
            id="dailyEmailEnabled"
            name="dailyEmailEnabled"
            type="checkbox"
          />
          <label className="text-sm font-semibold text-text" htmlFor="dailyEmailEnabled">
            Günlük e-posta özeti
          </label>
        </div>
        <p className="text-sm leading-6 text-text-muted" id="dailyEmailEnabled-help">
          Açık olduğunda, başarılı otomatik taramadan sonra yaklaşık günde bir kez yalnızca
          önceden doğrulanmış ve yetkilendirilmiş e-posta adresine kısa bir sağlık özeti gönderilir.
          Ürün kataloğunuz e-postayla paylaşılmaz.
          {!emailReady && settings.dailyEmailEnabled ? (
            <span className="mt-1 block">
              Mevcut e-posta ayarı açık kalır; işareti kaldırıp kaydederseniz kapatılır. Gönderim hazır
              olana kadar yeni özet ulaşmayabilir.
            </span>
          ) : null}
        </p>
        <div className="rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm text-text-muted">
          <p>{schedulerEnabled ? "Otomatik tarama hazır" : "Otomatik tarama henüz etkin değil"}</p>
          <p className="mt-1">
            {emailDeliveryConfigured ? "E-posta gönderimi hazır" : "E-posta gönderimi henüz hazır değil"}
          </p>
          <p className="mt-1">
            {recipientEmail
              ? `Doğrulanmış alıcı: ${maskEmail(recipientEmail)}`
              : "Doğrulanmış e-posta alıcısı yapılandırılmamış"}
          </p>
        </div>
      </div>

      <div>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover"
          type="submit"
        >
          Kaydet
        </button>
      </div>
    </form>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const status = readStatus(params.status);

  const installation = readInstallationSession(await getSession());
  if (!installation) {
    return (
      <StateScreen
        title="Ayarlar açılamadı"
        description="Bu sayfayı ikas mağazanızla açın ve uygulama bağlantısını yeniden doğrulayın."
      />
    );
  }

  let view;
  try {
    view = await readMonitoringSettings(installation);
  } catch (error) {
    if (error instanceof SettingsAccessError) {
      return (
        <StateScreen
          title="İzleme ayarları Pro özelliğidir"
          description="Düşük stok eşiği ve günlük e-posta özeti yalnız doğrulanmış aktif Pro aboneliklerde yapılandırılabilir."
        />
      );
    }
    if (error instanceof MonitoringSettingsStoreError) {
      return (
        <StateScreen
          title="Ayarlar şu anda yüklenemiyor"
          description="Kayıtlı ayarlarınıza şu anda erişilemiyor. Bir süre sonra yeniden deneyin."
        />
      );
    }
    throw error;
  }

  const schedulerEnabled = process.env.IKAS_MONITORING_SCHEDULER_ENABLED?.trim() === "true";
  const emailDeliveryConfigured = isDailySummaryEmailConfigured();
  let recipientEmail: string | undefined;
  try {
    recipientEmail = resolveVerifiedRecipient(installation)?.email;
  } catch {
    recipientEmail = undefined;
  }

  return (
    <main className="min-h-screen bg-canvas text-text">
      <IkasAppBridgeReady />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-title font-semibold tracking-tight">İzleme Ayarları</h1>
            <p className="mt-1 text-sm text-text-muted">Plan: Pro</p>
          </div>
          <nav aria-label="Ana navigasyon" className="flex flex-wrap gap-2">
            <Link className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium" href="/">Ürün Sağlığı</Link>
            <Link className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium" href="/history">Geçmiş</Link>
            <Link aria-current="page" className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium" href="/settings">Ayarlar</Link>
          </nav>
        </header>

        <StatusNotice status={status} />

        <section className="rounded-xl border border-border bg-surface p-6 shadow-card">
          <SettingsForm
            emailDeliveryConfigured={emailDeliveryConfigured}
            recipientEmail={recipientEmail}
            schedulerEnabled={schedulerEnabled}
            settings={view.settings}
          />
        </section>
      </div>
    </main>
  );
}
