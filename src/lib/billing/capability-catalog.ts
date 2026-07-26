import { APP_FEATURES, isFeatureEnabled, minimumTierFor, type AppFeature } from "./feature-policy";
import type { SemanticTier } from "./plan-catalog";
import type { Entitlement } from "./entitlement-service";

/**
 * The one description of what this app can do, for merchants.
 *
 * `feature-policy` stays the only authority on *authorization*; this module adds the merchant-
 * facing label, the description, and — the part that matters most — the honest rollout state. A
 * capability whose acceptance evidence does not exist yet is never rendered as available, no
 * matter what the tier says, because the tier answers "may you" and rollout answers "does it
 * actually work in production today".
 *
 * Nothing here mentions a price. `PRO_PLAN_KEY` is a Partner-panel listing key, not a price, and
 * no price, currency, billing interval or trial has been verified from a first-party source.
 */

export type CapabilityRollout =
  /** Shipped, enabled, and proven in production. */
  | "available"
  /** Shipped and enabled, but its production acceptance evidence is still narrow. */
  | "beta"
  /** Implemented and proven only against a development store; the production flag is off. */
  | "development_store_only"
  /** Implemented, but an operator-owned prerequisite is not configured. */
  | "needs_configuration";

/**
 * Deliberately carries no tier. The required tier is read from `feature-policy` at render time,
 * so a policy change cannot leave a stale "Free" badge behind in the merchant-facing copy.
 */
export type CapabilityRecord = {
  feature: AppFeature;
  title: string;
  description: string;
};

/**
 * Operator- and deployment-owned facts. They are resolved server-side and passed in, so the
 * catalog stays a pure function and the UI cannot invent a rollout state from a client guess.
 */
export type RolloutSignals = {
  /** Server-only product write kill switch. Off until the development-store canary passes. */
  productWritesEnabled: boolean;
  /** Bulk stays behind its own switch even after single writes open. */
  bulkWritesEnabled: boolean;
  schedulerEnabled: boolean;
  emailDeliveryConfigured: boolean;
  verifiedRecipientConfigured: boolean;
};

export const CAPABILITY_CATALOG: readonly CapabilityRecord[] = [
  {
    feature: "manual-scan",
    title: "Manuel katalog taraması",
    description:
      "Ürün ve stok bilgilerinizi canlı olarak okuyup SKU, barkod, görsel, fiyat, tekrarlanan başlık ve stok kurallarını denetler.",
  },
  {
    feature: "health-dashboard",
    title: "Mağaza sağlık skoru ve sorun panosu",
    description:
      "Son taramanın skorunu, kural bazlı özetini ve etkilenen ürün listesini tek ekranda gösterir.",
  },
  {
    feature: "csv-export",
    title: "CSV dışa aktarma",
    description: "Son tarama sonucunu tablo olarak indirir.",
  },
  {
    feature: "scheduled-scan",
    title: "Zamanlanmış günlük tarama",
    description: "Mağazanızı günde yaklaşık bir kez otomatik tarar.",
  },
  {
    feature: "scan-history",
    title: "Tarama geçmişi ve sorun farkları",
    description:
      "Önceki taramaları saklar; yeni, devam eden ve çözülen sorunları karşılaştırmalı olarak gösterir.",
  },
  {
    feature: "low-stock-threshold-config",
    title: "Düşük stok eşiği ayarı",
    description: "Hangi stok adedinin altında uyarı üretileceğini siz belirlersiniz.",
  },
  {
    feature: "daily-email-summary",
    title: "Günlük e-posta özeti",
    description:
      "Başarılı otomatik taramadan sonra yalnızca önceden doğrulanmış alıcıya kısa bir sağlık özeti gönderir.",
  },
  {
    feature: "low-stock-alerts",
    title: "Düşük stok eşik ve toparlanma bildirimleri",
    description:
      "Bir varyant eşiğin altına düştüğünde ve yeniden eşiğin üstüne çıktığında bildirir. Aynı durum için tekrar tekrar bildirim göndermez.",
  },
  {
    feature: "product-corrections-write",
    title: "Güvenli tekil SKU, fiyat ve stok düzeltmesi",
    description:
      "Önizleme, açık onay, tek seferlik doğrulama ve yazma sonrası kaynaktan okuma ile tek bir alanı düzeltir; geri alma da aynı güvenceyle çalışır.",
  },
  {
    feature: "bulk-corrections-write",
    title: "Toplu düzeltme",
    description:
      "Birden çok düzeltmeyi tek onayla, hız sınırına uyarak, her satırı ayrı doğrulayarak ve yarıda kalırsa güvenle kaldığı yerden devam ederek uygular.",
  },
];

export type CapabilityStatus = {
  feature: AppFeature;
  title: string;
  description: string;
  tier: SemanticTier;
  rollout: CapabilityRollout;
  /** Whether the merchant's current plan includes it, ignoring rollout. */
  includedInPlan: boolean;
  /** Whether the merchant can use it right now: plan, live entitlement state and rollout. */
  usableNow: boolean;
  /** Short Turkish badge derived from rollout and plan; never hardcoded in a component. */
  statusLabel: string;
};

export type CapabilityMatrix = {
  tier: SemanticTier;
  entitlementActive: boolean;
  capabilities: CapabilityStatus[];
};

function rolloutOf(feature: AppFeature, signals: RolloutSignals): CapabilityRollout {
  switch (feature) {
    case "manual-scan":
    case "health-dashboard":
    case "csv-export":
    case "scan-history":
    case "low-stock-threshold-config":
      return "available";
    case "scheduled-scan":
      return signals.schedulerEnabled ? "available" : "needs_configuration";
    case "daily-email-summary":
      return signals.schedulerEnabled &&
        signals.emailDeliveryConfigured &&
        signals.verifiedRecipientConfigured
        ? "available"
        : "needs_configuration";
    case "low-stock-alerts":
      // Threshold crossing and recovery run off the scheduled scan, so they inherit its prerequisites.
      return signals.schedulerEnabled ? "beta" : "needs_configuration";
    case "product-corrections-write":
      return signals.productWritesEnabled ? "beta" : "development_store_only";
    case "bulk-corrections-write":
      return signals.bulkWritesEnabled ? "beta" : "development_store_only";
  }
}

const ROLLOUT_LABEL: Record<CapabilityRollout, string> = {
  available: "Kullanımda",
  beta: "Beta",
  development_store_only: "Geliştirme mağazasıyla sınırlı",
  needs_configuration: "Kapalı — kurulum gerekiyor",
};

function statusLabelFor(
  rollout: CapabilityRollout,
  includedInPlan: boolean,
  entitlementActive: boolean,
): string {
  if (!includedInPlan) return "PRO ile";
  if (!entitlementActive) return "Plan doğrulanamadı";
  return ROLLOUT_LABEL[rollout];
}

/**
 * The merchant-facing matrix for one installation. `usableNow` is deliberately stricter than
 * `includedInPlan`: a Pro merchant still sees a correction capability marked as development-store
 * limited until an operator turns the production flag on.
 */
export function resolveCapabilityMatrix(
  entitlement: Pick<Entitlement, "tier" | "state">,
  signals: RolloutSignals,
): CapabilityMatrix {
  const entitlementActive = entitlement.state === "active";
  const tier = entitlementActive ? entitlement.tier : "free";

  return {
    tier,
    entitlementActive,
    capabilities: CAPABILITY_CATALOG.map((record) => {
      const rollout = rolloutOf(record.feature, signals);
      const includedInPlan = isFeatureEnabled(record.feature, tier);
      return {
        ...record,
        tier: minimumTierFor(record.feature) ?? "pro",
        rollout,
        includedInPlan,
        usableNow:
          includedInPlan &&
          entitlementActive &&
          (rollout === "available" || rollout === "beta"),
        statusLabel: statusLabelFor(rollout, includedInPlan, entitlementActive),
      };
    }),
  };
}

/** Every authorization feature must have exactly one merchant-facing record; asserted by tests. */
export function catalogCoversEveryFeature(): boolean {
  const covered = CAPABILITY_CATALOG.map((record) => record.feature);
  return (
    covered.length === APP_FEATURES.length &&
    APP_FEATURES.every((feature) => covered.includes(feature)) &&
    new Set(covered).size === covered.length
  );
}
