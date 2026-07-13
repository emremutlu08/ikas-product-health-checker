export const OAUTH_FAILURE_REASONS = [
  "invalid_store_name",
  "oauth_config_missing",
  "oauth_authorize_failed",
  "callback_invalid",
  "state_missing",
  "session_state_missing",
  "state_mismatch",
  "token_exchange_failed",
  "app_context_http_failed",
  "app_context_graphql_error",
  "merchant_context_missing",
  "authorized_app_missing",
  "token_store_unavailable",
  "token_persist_failed",
  "session_save_failed",
  "unexpected_error",
] as const;

export type OAuthFailureReason = (typeof OAUTH_FAILURE_REASONS)[number];

export type OAuthFailureMessage = {
  title: string;
  detail: string;
  action: string;
};

const OAUTH_FAILURE_REASON_SET = new Set<string>(OAUTH_FAILURE_REASONS);

export const OAUTH_FAILURE_MESSAGES: Record<OAuthFailureReason, OAuthFailureMessage> = {
  invalid_store_name: {
    title: "Mağaza adı doğrulanamadı.",
    detail: "ikas admin adresinin tamamı yerine mağaza alt alan adını kullanmalısın.",
    action: "Aşağıdaki alanı kontrol edip yeniden dene.",
  },
  oauth_config_missing: {
    title: "Bağlantı sunucu yapılandırması eksik.",
    detail: "Yetkilendirme bu nedenle güvenli biçimde başlatılamadı.",
    action: "Tekrar denemek yerine destek kodunu uygulama ekibiyle paylaş.",
  },
  oauth_authorize_failed: {
    title: "ikas yetkilendirmesi başlatılamadı.",
    detail: "Geçici bir bağlantı veya oturum sorunu oluşmuş olabilir.",
    action: "Yeni bir sekmede tekrar dene; sorun sürerse destek kodunu paylaş.",
  },
  callback_invalid: {
    title: "ikas dönüş bilgileri eksik.",
    detail: "Yetkilendirme bağlantısı tamamlanmadan veya süresi dolduktan sonra açılmış olabilir.",
    action: "Bu sayfayı kapatıp mağaza bağlantısını baştan başlat.",
  },
  state_missing: {
    title: "Güvenlik doğrulaması eksik.",
    detail: "ikas dönüşünde zorunlu güvenlik durumu bulunamadı.",
    action: "Eski sekmeyi kapatıp mağaza bağlantısını yeniden başlat.",
  },
  session_state_missing: {
    title: "Yetkilendirme oturumu sona ermiş.",
    detail: "Başlangıç oturumu tarayıcıda artık bulunamıyor.",
    action: "Çerezlere izin verip mağaza bağlantısını yeniden başlat.",
  },
  state_mismatch: {
    title: "Güvenlik doğrulaması eşleşmedi.",
    detail: "Dönüş isteği bu tarayıcıda başlatılan yetkilendirmeye ait görünmüyor.",
    action: "Açık eski yetkilendirme sekmelerini kapatıp yeniden dene.",
  },
  token_exchange_failed: {
    title: "ikas erişim anahtarı alınamadı.",
    detail: "Yetkilendirme kodu süresi dolmuş veya daha önce kullanılmış olabilir.",
    action: "Mağaza bağlantısını baştan başlat; sorun sürerse destek kodunu paylaş.",
  },
  app_context_http_failed: {
    title: "ikas mağaza bilgilerine ulaşılamadı.",
    detail: "ikas yönetim API’si isteği tamamlayamadı.",
    action: "Kısa süre sonra tekrar dene; sorun sürerse destek kodunu paylaş.",
  },
  app_context_graphql_error: {
    title: "ikas uygulama bağlamı doğrulanamadı.",
    detail: "ikas mağaza veya uygulama bilgilerini döndürürken hata bildirdi.",
    action: "Uygulamayı yeniden yetkilendir; sorun sürerse destek kodunu paylaş.",
  },
  merchant_context_missing: {
    title: "ikas mağaza kimliği doğrulanamadı.",
    detail: "Yetkilendirme yanıtında zorunlu mağaza bağlamı yoktu.",
    action: "Uygulamayı mağaza panelinden yeniden açıp tekrar yetkilendir.",
  },
  authorized_app_missing: {
    title: "Yetkili uygulama kimliği bulunamadı.",
    detail: "Kurulum kalıcı mağaza kaydıyla eşleştirilemediği için tamamlanmadı.",
    action: "Uygulamayı mağaza panelinden yeniden kur; sorun sürerse destek kodunu paylaş.",
  },
  token_store_unavailable: {
    title: "Güvenli bağlantı deposu hazır değil.",
    detail: "Erişim bilgileri kalıcı sunucu deposuna yazılamayacağı için kurulum tamamlanmadı.",
    action: "Tekrar denemek yerine destek kodunu uygulama ekibiyle paylaş.",
  },
  token_persist_failed: {
    title: "Mağaza bağlantısı güvenli biçimde kaydedilemedi.",
    detail: "Kalıcı kayıt ve doğrulama tamamlanmadığı için uygulama bağlı sayılmadı.",
    action: "Kısa süre sonra yeniden dene; sorun sürerse destek kodunu paylaş.",
  },
  session_save_failed: {
    title: "Yetkilendirme oturumu tamamlanamadı.",
    detail: "Kalıcı bağlantı oluşturuldu ancak tarayıcı oturumu güvenli biçimde kapatılamadı.",
    action: "Çerezlere izin verip yeniden dene; sorun sürerse destek kodunu paylaş.",
  },
  unexpected_error: {
    title: "ikas yetkilendirmesi tamamlanamadı.",
    detail: "Beklenmeyen ve güvenli biçimde gizlenen bir sunucu hatası oluştu.",
    action: "Yeniden dene; sorun sürerse destek kodunu uygulama ekibiyle paylaş.",
  },
};

export function parseOAuthFailureReason(value?: string | null): OAuthFailureReason {
  return value && OAUTH_FAILURE_REASON_SET.has(value) ? (value as OAuthFailureReason) : "unexpected_error";
}

export function normalizeOAuthSupportId(value?: string | null) {
  const normalized = value?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized.toLowerCase()
    : "";
}
