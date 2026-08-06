import { AppNav } from "@/components/AppNav";
import { CapabilityMatrix } from "@/components/CapabilityMatrix";
import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { resolveCapabilityMatrix } from "@/lib/billing/capability-catalog";
import { resolveRolloutSignals } from "@/lib/billing/rollout-signals";
import { resolveInstallationEntitlement } from "@/lib/billing/runtime-entitlement";
import { getSession, readInstallationSession } from "@/lib/session";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * The plan surface: what this merchant's installation can actually do today.
 *
 * The entitlement resolver is fail-closed, so an unreadable licence renders the Free column as
 * the merchant's own — never an optimistic Pro. Every row's status comes from the same policy the
 * routes enforce, so nothing on this page can promise a capability the server would refuse.
 */
export default async function PlanPage() {
  const installation = readInstallationSession(await getSession());

  if (!installation) {
    return (
      <main className="min-h-screen bg-canvas px-4 py-10 text-text">
        <IkasAppBridgeReady />
        <section className="mx-auto max-w-2xl rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="text-title font-semibold">Plan bilgisi açılamadı</h1>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            Bu sayfayı ikas mağazanızla açın ve uygulama bağlantısını yeniden doğrulayın.
          </p>
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

  const entitlement = await resolveInstallationEntitlement(installation);
  const matrix = resolveCapabilityMatrix(entitlement, resolveRolloutSignals(installation));

  return (
    <main className="min-h-screen bg-canvas text-text">
      <IkasAppBridgeReady />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5">
          <div>
            <h1 className="text-title font-semibold tracking-tight">Plan ve yetenekler</h1>
            <p className="mt-1 text-sm text-text-muted">Mağaza: {installation.storeName}</p>
          </div>

          <AppNav current="/plan" />
        </header>

        <CapabilityMatrix matrix={matrix} />
      </div>
    </main>
  );
}
