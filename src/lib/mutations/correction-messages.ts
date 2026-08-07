import type { HealthIssueCode } from "@/lib/ikas/types";
import type { MutationOperationKind } from "./mutation-operation";

/**
 * Merchant-facing Turkish copy for every outcome a correction can produce.
 *
 * The map is exhaustive on purpose: an unmapped server code falls back to a message that says the
 * app is not sure what happened and tells the merchant to check their catalog, which is the only
 * honest thing to say about an outcome the app has no verified answer for.
 */

export const CORRECTABLE_ISSUE_KIND: Partial<Record<HealthIssueCode, MutationOperationKind>> = {
  missing_sku: "sku_change",
  duplicate_sku: "sku_change",
  missing_price: "price_change",
  zero_stock_blocked: "stock_change",
  low_stock: "stock_change",
};

export const CORRECTION_KIND_LABEL: Record<MutationOperationKind, string> = {
  sku_change: "SKU düzeltmesi",
  price_change: "Fiyat düzeltmesi",
  stock_change: "Stok düzeltmesi",
};

export const CORRECTION_FIELD_LABEL: Record<MutationOperationKind, string> = {
  sku_change: "Yeni SKU",
  price_change: "Yeni satış fiyatı",
  stock_change: "Yeni stok adedi",
};

export const CORRECTION_ERROR_MESSAGES: Record<string, string> = {
  IKAS_CORRECTION_WRITE_DISABLED:
    "Düzeltme yazma yüzeyi şu anda kapalı. Geliştirme mağazası doğrulaması tamamlanana kadar açılmaz.",
  IKAS_CORRECTION_FEATURE_REQUIRED:
    "Bu işlem PRO paketine dahildir ve aktif bir abonelik doğrulanmalıdır.",
  IKAS_LIVE_AUTH_REQUIRED: "Mağaza bağlantınızın süresi doldu. Uygulamayı ikas panelinden yeniden açın.",
  IKAS_CORRECTION_ORIGIN_INVALID: "İstek doğrulanamadı. Sayfayı yenileyip yeniden deneyin.",
  IKAS_CORRECTION_INVALID_REQUEST: "Girdiğiniz değer geçerli değil. Kontrol edip yeniden deneyin.",
  IKAS_CORRECTION_INVALID_REQUEST_BODY: "Girdiğiniz değer geçerli değil. Kontrol edip yeniden deneyin.",
  IKAS_CORRECTION_ISSUE_NOT_FOUND:
    "Bu sorun son taramada bulunamadı. Yeni bir tarama yapıp yeniden deneyin.",
  IKAS_CORRECTION_SNAPSHOT_REQUIRED: "Önce bir tarama yapmanız gerekiyor.",
  IKAS_CORRECTION_SNAPSHOT_STALE: "Son tarama güncelliğini yitirdi. Yeni bir tarama yapın.",
  IKAS_CORRECTION_NO_CHANGE: "Girdiğiniz değer mevcut değerle aynı; değişiklik yapılmadı.",
  IKAS_CORRECTION_PRODUCT_MISSING: "Ürün artık bulunamıyor.",
  IKAS_CORRECTION_VARIANT_MISSING: "Varyant artık bulunamıyor.",
  IKAS_CORRECTION_PRICE_ROW_MISSING: "Bu varyantın varsayılan fiyat kaydı bulunamadı.",
  IKAS_CORRECTION_PRICE_ROW_AMBIGUOUS:
    "Bu varyantta birden fazla varsayılan fiyat kaydı var; güvenli bir düzeltme yapılamıyor.",
  IKAS_CORRECTION_STOCK_LOCATION_MISSING: "Seçilen stok konumu bulunamadı.",
  IKAS_CORRECTION_STOCK_LOCATION_AMBIGUOUS:
    "Bu varyantın birden fazla stok konumu var; hangisini güncelleyeceğinizi seçin.",
  IKAS_CORRECTION_STALE_GUARD_UNAVAILABLE:
    "Güvenli karşılaştırma için gereken bilgi okunamadı. Yeni bir tarama yapıp yeniden deneyin.",
  IKAS_CORRECTION_OPERATION_CONFLICT: "Bu işlem için zaten bir onay bekliyor.",
  IKAS_CORRECTION_CONFIRMATION_MISSING: "Onay kaydı bulunamadı. Önizlemeyi yeniden oluşturun.",
  IKAS_CORRECTION_CONFIRMATION_EXPIRED: "Onay süresi doldu. Önizlemeyi yeniden oluşturun.",
  IKAS_CORRECTION_CONFIRMATION_REPLAY: "Bu onay zaten kullanıldı. Aynı işlem ikinci kez çalıştırılmaz.",
  IKAS_CORRECTION_STALE_PRODUCT:
    "Ürün önizlemeden sonra değişti. Hiçbir şey yazılmadı; yeniden önizleyin.",
  IKAS_CORRECTION_STALE_VALUE:
    "Bu alan önizlemeden sonra başka bir yerde değişti. Hiçbir şey yazılmadı; yeniden önizleyin.",
  IKAS_CORRECTION_WRITE_REJECTED: "ikas bu değişikliği kabul etmedi. Kataloğunuzda değişiklik olmadı.",
  IKAS_CORRECTION_PREFLIGHT_FAILED: "ikas'a şu anda ulaşılamıyor. Hiçbir şey yazılmadı.",
  IKAS_CORRECTION_RATE_LIMITED:
    "ikas hız sınırına ulaşıldı; hiçbir şey yazılmadı. Kısa bir süre sonra yeni bir önizleme oluşturun.",
  IKAS_CORRECTION_MUTATION_OUTCOME_UNKNOWN:
    "İşlemin sonucu doğrulanamadı. Ürününüzü kontrol edin; aynı işlemi tekrar çalıştırmayın.",
  IKAS_CORRECTION_VERIFICATION_FAILED:
    "Yazma sonrası doğrulama beklenen değeri göstermedi. Ürününüzü kontrol edin.",
  IKAS_CORRECTION_INVARIANT_VIOLATION:
    "Yalnızca hedeflenen alanın değişmesi gerekiyordu, fakat başka alanlar da değişmiş görünüyor. Ürününüzü kontrol edin.",
  IKAS_CORRECTION_UNDO_BASELINE_CHANGED:
    "Bu alan bu uygulamanın yazdığı değerden farklı. Başkasının değişikliğini geri almamak için işlem reddedildi.",
  IKAS_CORRECTION_UNDO_NOT_AVAILABLE: "Bu düzeltmenin güvenli bir geri alması bulunmuyor.",
  IKAS_CORRECTION_OPERATION_NOT_UNDOABLE: "Yalnızca doğrulanmış başarılı düzeltmeler geri alınabilir.",
  IKAS_CORRECTION_OPERATION_MISSING: "Bu işlem kaydı bulunamadı.",
  IKAS_CORRECTION_BACKEND_UNAVAILABLE: "Güvenli işlem deposuna şu anda erişilemiyor. Sonra deneyin.",
  IKAS_CORRECTION_UPSTREAM_UNAVAILABLE: "ikas'a şu anda ulaşılamıyor. Sonra deneyin.",
  IKAS_CORRECTION_UNAVAILABLE: "Düzeltme yüzeyi şu anda kullanılamıyor.",
  IKAS_CORRECTION_ORIGIN_NOT_ALLOWED:
    "Bu düzeltme bir toplu işleme ait; tek tek değil, toplu işlem ekranından çalıştırılır.",
  IKAS_CORRECTION_FAILED: "İşlem tamamlanamadı.",
};

export const UNKNOWN_CORRECTION_MESSAGE =
  "İşlemin sonucu doğrulanamadı. Ürününüzü kontrol edin; aynı işlemi tekrar çalıştırmayın.";

export function correctionErrorMessage(code: unknown): string {
  return typeof code === "string" && code in CORRECTION_ERROR_MESSAGES
    ? CORRECTION_ERROR_MESSAGES[code]!
    : UNKNOWN_CORRECTION_MESSAGE;
}

/**
 * Restated rather than imported from `bulk-batch-store`, which reaches Redis and must not be
 * pulled into the browser bundle by a copy table. A test asserts the two stay equal.
 */
export const BULK_SELECTION_LIMIT = 50;

/** Failures of the batch as a whole, which say nothing about any individual correction. */
export const BULK_ERROR_MESSAGES: Record<string, string> = {
  IKAS_BULK_WRITE_DISABLED:
    "Toplu düzeltme şu anda kapalı. Kataloğunuzda hiçbir değişiklik yapılmadı.",
  IKAS_BULK_FEATURE_REQUIRED:
    "Toplu düzeltme PRO paketine dahildir ve aktif bir abonelik doğrulanmalıdır.",
  IKAS_BULK_INVALID_REQUEST: "Seçiminiz geçerli değil. Sayfayı yenileyip yeniden deneyin.",
  IKAS_BULK_TOO_MANY_ITEMS: `Tek seferde en fazla ${BULK_SELECTION_LIMIT} düzeltme seçebilirsiniz.`,
  IKAS_BULK_DUPLICATE_TARGET: "Aynı varyant için aynı düzeltme birden fazla kez seçilmiş.",
  IKAS_BULK_BATCH_MISSING: "Bu toplu işlem bulunamadı. Yeni bir önizleme oluşturun.",
  IKAS_BULK_BATCH_EXPIRED:
    "Onay süresi doldu ve hiçbir şey yazılmadı. Yeni bir önizleme oluşturun.",
  IKAS_BULK_BATCH_REPLAY: "Bu toplu işlem zaten çalıştırıldı; ikinci kez çalıştırılmaz.",
  IKAS_BULK_BATCH_CANCELLED: "Bu toplu işlem iptal edildi.",
  IKAS_BULK_PLAN_MISMATCH:
    "Onayladığınız liste değişmiş görünüyor. Hiçbir şey yazılmadı; yeniden önizleyin.",
  IKAS_BULK_NO_READY_ITEMS:
    "Seçtiğiniz düzeltmelerin hiçbiri şu anda uygulanabilir durumda değil.",
};

export const UNKNOWN_BULK_MESSAGE =
  "Toplu işlemin sonucu doğrulanamadı. Ürünlerinizi kontrol edin; aynı işlemi tekrar çalıştırmayın.";

export function bulkErrorMessage(code: unknown): string {
  if (typeof code !== "string") return UNKNOWN_BULK_MESSAGE;
  if (code in BULK_ERROR_MESSAGES) return BULK_ERROR_MESSAGES[code]!;
  // A batch can also fail for the same reasons a single correction can, and those already have
  // merchant-facing wording. Falling through keeps one vocabulary instead of two.
  if (code in CORRECTION_ERROR_MESSAGES) return CORRECTION_ERROR_MESSAGES[code]!;
  return UNKNOWN_BULK_MESSAGE;
}

/**
 * Per-item reasons arrive as bare sanitized codes (`no_change`, `stale_guard_unavailable`, …)
 * rather than the prefixed form the HTTP layer uses, because they are produced deep in the
 * planning and execution services. They name the same conditions, so they resolve against the same
 * table instead of a parallel one that would drift out of step with it.
 */
export function bulkItemReasonMessage(reason: unknown): string {
  if (typeof reason !== "string" || reason === "") return UNKNOWN_CORRECTION_MESSAGE;
  return correctionErrorMessage(`IKAS_CORRECTION_${reason.toUpperCase()}`);
}
