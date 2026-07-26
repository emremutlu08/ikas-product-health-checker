import type { CapabilityMatrix as CapabilityMatrixData, CapabilityStatus } from "@/lib/billing/capability-catalog";

/**
 * The Free vs PRO comparison, rendered straight from the resolved capability matrix.
 *
 * Nothing here restates a plan rule or a rollout state in markup — every label, badge and tick
 * comes from the matrix the server resolved, so the screen cannot drift from the policy that
 * actually authorizes the work. A capability the merchant may not use yet is rendered as
 * unavailable text, never as an actionable control.
 */

export type CapabilityMatrixProps = {
  matrix: CapabilityMatrixData;
};

const TIER_LABEL = { free: "Free", pro: "PRO" } as const;

function ToneClass(capability: CapabilityStatus) {
  if (!capability.includedInPlan) return "border-border bg-surface-sunken text-text-muted";
  if (capability.usableNow) return "border-success bg-success-surface text-success";
  return "border-warning bg-warning-surface text-warning";
}

function Availability({ capability, tier }: { capability: CapabilityStatus; tier: "free" | "pro" }) {
  const includedAtTier = tier === "pro" || capability.tier === "free";
  return (
    <td className="px-3 py-3 text-center align-middle">
      <span aria-hidden="true">{includedAtTier ? "✓" : "—"}</span>
      <span className="sr-only">
        {includedAtTier
          ? `${TIER_LABEL[tier]} pakete dahil`
          : `${TIER_LABEL[tier]} pakete dahil değil`}
      </span>
    </td>
  );
}

export function CapabilityMatrix({ matrix }: CapabilityMatrixProps) {
  const planLabel = TIER_LABEL[matrix.tier];

  return (
    <section aria-labelledby="capability-matrix-heading" className="flex flex-col gap-4">
      <div>
        <h2 className="text-title font-semibold text-text" id="capability-matrix-heading">
          Free ve PRO karşılaştırması
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
          Aşağıdaki liste uygulamanın gerçek durumunu gösterir. Bir özellik yalnızca üretimde
          çalıştığı doğrulandığında <strong>Kullanımda</strong> olarak işaretlenir; doğrulaması
          tamamlanmamış özellikler açıkça beta, kapalı veya geliştirme mağazasıyla sınırlı olarak
          belirtilir.
        </p>
        <p className="mt-2 text-sm text-text-muted">
          {matrix.entitlementActive
            ? `Mevcut planınız: ${planLabel}.`
            : "Plan bilgisi şu anda doğrulanamadı; yalnızca Free yetenekleri açık kabul edilir."}
        </p>
      </div>

      {/*
        Wide content scrolls inside its own container so the page never scrolls sideways.
        `min-w-0` is load-bearing: as a flex child this element defaults to `min-width: auto`,
        which lets the wide table push the whole page instead of scrolling within itself.
      */}
      <div className="min-w-0 overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            Uygulama yeteneklerinin Free ve PRO paketlerine göre karşılaştırması ve güncel yayın
            durumu
          </caption>
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className="px-4 py-3 font-semibold text-text" scope="col">
                Yetenek
              </th>
              <th className="px-3 py-3 text-center font-semibold text-text" scope="col">
                Free
              </th>
              <th className="px-3 py-3 text-center font-semibold text-text" scope="col">
                PRO
              </th>
              <th className="px-4 py-3 font-semibold text-text" scope="col">
                Durum
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.capabilities.map((capability) => (
              <tr className="border-b border-border last:border-b-0" key={capability.feature}>
                <th className="px-4 py-3 align-top font-medium text-text" scope="row">
                  {capability.title}
                  <span className="mt-1 block text-sm font-normal leading-6 text-text-muted">
                    {capability.description}
                  </span>
                </th>
                <Availability capability={capability} tier="free" />
                <Availability capability={capability} tier="pro" />
                <td className="px-4 py-3 align-top">
                  <span
                    className={`inline-flex rounded-md border px-2 py-1 text-sm font-medium ${ToneClass(capability)}`}
                  >
                    {capability.statusLabel}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm leading-6 text-text-muted">
        PRO paketinin fiyatı, para birimi, faturalama aralığı ve deneme süresi burada
        gösterilmiyor; bu bilgiler ikas Marketplace listelemesinden doğrulanmadan uygulamada yer
        almaz.
      </p>
    </section>
  );
}
