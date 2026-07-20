# Ücretli Abonelikler ve Plan Yetkilendirme Uygulama Planı

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Ürün Sağlığı Asistanı’nı mevcut ücretsiz manuel raporu bozmadan, ikas’ın yerel plan sistemi üzerinden satılan yıllık bir Pro aboneliğe dönüştürmek.

**Architecture:** Free kullanıcılar mevcut canlı, read-only manuel tarama ve CSV akışını korur. Pro; zamanlanmış tarama, geçmiş/diff, gerçek düşük stok eşikleri ve doğrulanmış e-posta bildirimleri ekler. `getMerchantLicence` yetkinin kaynağıdır; ödeme webhook’u yalnızca cache invalidation/yeniden doğrulama sinyalidir. Tüm entitlement kontrolleri sunucu tarafında ve tenant-bound yapılır.

**Tech Stack:** Next.js 16.2.10, TypeScript, ikas Admin GraphQL, `getMerchantLicence`, ikas webhooks, Upstash Redis REST, Vercel Cron, Resend, Vitest, Playwright.

**Planning review:** Hermes + Claude Code 2.1.215 / Claude Opus 4.8 / high effort. Claude’un ana itirazları plana işlendi: Pro yalnızca e-posta paketi olmamalı; history+diff eklenmeli, trial `merchantId` ile tutulmalı, uninstall temizliği ücretli yayından önce tamamlanmalı, webhook tek başına yetki vermemeli ve mevcut `lowStockRiskCount` gerçek eşik değildir.

---

## 1. Ürün ve paket kararı

### İlk yayın: Free + tek ücretli Pro

Türkiye’de yalnız yıllık uygulama planı satılabilmesi ve aktif plan yükseltmenin henüz desteklenmemesi nedeniyle ilk sürümde yalnızca bir ücretli katman açılacak. İkinci ve üçüncü ücretli slotlar gerçek ödeme ve kullanım verisi gelene kadar boş tutulacak.

| Özellik | Free | Pro Yıllık |
|---|---:|---:|
| Canlı, manuel ürün sağlık taraması | ✓ | ✓ |
| Mevcut sağlık kuralları ve filtreleme | ✓ | ✓ |
| Tam CSV raporu | ✓ | ✓ |
| Zamanlanmış günlük tarama | — | ✓ |
| Tarama geçmişi | — | ✓ |
| Yeni oluşan / çözülen sorun diff’i | — | ✓ |
| Gerçek düşük stok eşiği | — | ✓ |
| Günlük e-posta özeti | — | ✓, ilk sürümde 1 doğrulanmış alıcı |
| Çoklu alıcı, anlık bildirim, Slack | — | Faz 2+ |
| Otomatik ürün/stok düzeltme | — | Faz 2+, ayrı güvenlik kapısı |

### Bilinçli ürün kararları

- CSV ücretsiz kalır; ücretsiz rapor merchant’ın ürüne güvenmesini ve çıktıyı paylaşmasını sağlar.
- Pro’nun ana satışı “e-posta” değil, **sürekli izleme + geçmiş + regresyon tespiti** olacaktır.
- Mevcut `lowStockRiskCount`, gerçekte `zero_stock_blocked` sayısını temsil ediyor. Pro yayınlanmadan önce gerçek `stockCount <= threshold` modeli geliştirilecek; mevcut metrik ücretli düşük stok özelliği diye satılmayacak.
- Ürün/katalog limitleri fiyat duvarı olarak rastgele seçilmeyecek. Önce gerçek kataloglarda süre ve API yükü benchmark edilecek; Free/Pro sınırları bu ölçümden sonra Partner plan açıklamasına yazılacak.
- Pro planına 14 günlük deneme ancak trial state machine ve reinstall koruması tamamlandıktan sonra eklenecek.

### Plan anahtarı

TR için ilk immutable anahtar önerisi:

```text
product-health-pro-try-v1
```

Uygulama kodu bu anahtarı doğrudan özellik kontrollerine yaymayacak; semantic tier map kullanacak:

```ts
const PLAN_KEY_TO_TIER = {
  "product-health-pro-try-v1": "pro",
} as const;
```

Fiyat veya yeni paket nedeniyle ileride başka key oluşursa aynı semantic tier’a eşlenebilir. Kaydedilmiş ikas anahtarı değiştirilemeyeceği için key, Partner panelinde kaydetmeden önce iki kişi tarafından doğrulanmalıdır.

### Fiyat kararı kapısı

Bu plan fiyat uydurmaz. Fiyat seçilmeden önce:

1. En az 5 gerçek ikas mağazasında bulunan kritik sorun ve stok riski sayısı kaydedilecek.
2. En az 3 merchant’a yıllık Pro teklif metni gösterilecek.
3. İki fiyat hipotezi, yıllık taahhüt ve kalan ikas lisans gününe göre prorasyon açıkça anlatılarak test edilecek.
4. Partner panelindeki fiyat ancak bu görüşmelerden sonra girilecek.

---

## 2. Yetkilendirme durum modeli

```ts
type SemanticTier = "free" | "pro";
type EntitlementState = "active" | "trialing" | "grace" | "inactive" | "unknown";

type Entitlement = {
  authorizedAppId: string;
  merchantId: string;
  tier: SemanticTier;
  state: EntitlementState;
  planKey?: string;
  verifiedAt: number;
  graceUntil?: number;
  source: "live" | "cache";
};
```

Kurallar:

- `getMerchantLicence.appSubscriptions` içinde bu uygulamaya ait aktif kayıt yoksa Free.
- Kayıt; `authorizedAppId` eşleşmeli, `status === "ACTIVE"` olmalı ve `deleted !== true` olmalı.
- `storeAppListingSubscriptionKey` sadece sunucu tarafındaki allowlist map üzerinden semantic tier’a çevrilir.
- Bilinmeyen key yetki vermez ve yapılandırılmış alarm üretir.
- Webhook hiçbir zaman tek başına Pro yetkisi vermez; cache’i invalidate eder ve canlı lisans kontrolünü tetikler.
- Yeni yetki verme fail-closed’dur. Daha önce doğrulanmış aktif abonelikte geçici ikas kesintisi için kısa TTL + sınırlı grace uygulanır; grace bitince Pro kapanır.
- Her cron işi başlamadan hemen önce lisans canlı doğrulanır; sadece eski cache ile ücretli iş çalıştırılmaz.
- Entitlement iron-session cookie’sine veya query string’e yazılmaz.

---

## 3. Fazlar

## Faz 0 — Monetizasyon öncesi zorunlu güvenlik ve ölçüm

### Task 1: Talep sinyalini ölçülebilir hale getir

**Objective:** Mevcut `mailto:` CTA’yı tenant-bound, sunucu tarafı bir ilgi kaydına dönüştürmek.

**Files:**
- Create: `src/lib/interest/interest-store.ts`
- Create: `src/lib/interest/interest-store.test.ts`
- Create: `src/app/api/interest/route.ts`
- Create: `src/app/api/interest/route.test.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.test.tsx`

**Steps:**
1. RED: Session olmadan ilgi kaydı açılamadığını test et.
2. RED: Aynı `authorizedAppId + intent` için tekrar çağrının idempotent olduğunu test et.
3. Redis kaydını minimum alanlarla uygula: `authorizedAppId`, `merchantId`, `intent`, `createdAt`; token veya ürün verisi saklama.
4. `mailto:` CTA’yı POST aksiyonuna çevir; başarılı durumda ölçülebilir teşekkür durumu göster.
5. Focused testleri çalıştır.
6. Commit: `feat: record paid feature interest`

### Task 2: Gerçek düşük stok modelini tanımla

**Objective:** `zero_stock_blocked` ile gerçek eşik bazlı düşük stok kavramını ayırmak.

**Files:**
- Modify: `src/lib/ikas/types.ts`
- Modify: `src/lib/ikas/health-rules.ts`
- Modify: `src/lib/ikas/health-rules.test.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.test.tsx`

**Steps:**
1. RED: `stockCount <= configuredThreshold` için varyant bazlı düşük stok testlerini yaz; sıfır stok, negatif stok ve çok lokasyon toplamını kapsa.
2. `lowStockRiskCount` takma adını kaldır veya `outOfStockBlockedCount` olarak yeniden adlandır.
3. Ücretli CTA metnini gerçek eşik özelliği hazır olana kadar “stok izleme” hipotezi olarak dürüstçe güncelle.
4. Var olan sağlık skoru davranışını değiştirmediğini test et.
5. Commit: `fix: separate low stock thresholds from out of stock issues`

### Task 3: Katalog taramasına güvenli çalışma bütçesi ekle

**Objective:** Sınırsız pagination nedeniyle Vercel timeout ve ikas API yükü riskini önlemek.

**Files:**
- Modify: `src/lib/ikas/product-adapter.ts`
- Modify: `src/lib/ikas/product-adapter.test.ts`
- Modify: `src/lib/ikas/errors.ts`

**Steps:**
1. RED: `maxPages`, `maxProducts` ve toplam süre bütçesi aşım testlerini yaz.
2. Sessiz kısmi rapor döndürme; bütçe aşımını typed error veya açık `scanStatus` olarak modelle.
3. En az küçük, orta ve büyük fixture ile benchmark scripti eklemeden önce mevcut adapter testleri üzerinden çağrı sayısını ölç.
4. Gerçek mağaza benchmark sonuçlarına göre Free/Pro limit kararını ayrı bir ürün kabul kapısı olarak kaydet.
5. Commit: `fix: bound ikas product pagination`

### Task 4: ikas webhook imza sözleşmesini doğrula

**Objective:** Kod yazmadan önce imza algoritması, raw-body kullanımı, secret kaynağı ve retry davranışı için first-party sözleşme elde etmek.

**Files:**
- Create: `docs/ikas-webhook-contract.md`

**Steps:**
1. ikas dokümanından `store/app/payment` ve `store/app/deleted` payload alanlarını kaydet.
2. ikas’tan imza üretim algoritmasını ve hangi secret’ın kullanıldığını yazılı doğrula.
3. Timestamp/replay penceresi ve retry/idempotency beklentisini doğrula.
4. Sözleşme net değilse webhook kodlamasını BLOCKED bırak; payload’daki `signature` alanının varlığını doğrulama sayma.
5. Commit: `docs: record verified ikas webhook contract`

### Task 5: Uninstall temizliğini uygula

**Objective:** Uygulama kaldırıldığında token ve tenant’a ait ücretli özellik verilerini güvenli biçimde silmek.

**Files:**
- Create: `src/lib/ikas/webhook-signature.ts`
- Create: `src/lib/ikas/webhook-signature.test.ts`
- Create: `src/app/api/webhooks/ikas/route.ts`
- Create: `src/app/api/webhooks/ikas/route.test.ts`
- Modify: `src/lib/ikas/token-store.ts`
- Modify: `src/lib/ikas/token-store.test.ts`
- Modify: `README.md`

**Steps:**
1. RED: Bozuk imza, yanlış `authorizedAppId`, replay ve duplicate event testlerini yaz.
2. İmzayı raw body üzerinde doğrula; parsed JSON’u doğrulama girdisi olarak kullanma.
3. `store/app/deleted` için token, entitlement cache, alıcı, schedule ve snapshot kayıtlarını silen tenant cleanup servisi ekle.
4. Trial tüketim kaydını silme; reinstall ile ikinci trial oluşmasını engellemek için `merchantId` bazlı minimum kayıt korunacak.
5. RED/GREEN: Kaldırılmış merchant için cron/API çağrısı ve e-posta oluşmadığını kanıtla.
6. Commit: `feat: clean up ikas installation on uninstall`

---

## Faz 1 — Entitlement temeli ve ikas plan entegrasyonu

### Task 6: Plan kataloğu ve feature policy oluştur

**Objective:** ikas plan key’lerini semantic tier ve uygulama özelliklerinden ayırmak.

**Files:**
- Create: `src/lib/billing/plan-catalog.ts`
- Create: `src/lib/billing/plan-catalog.test.ts`
- Create: `src/lib/billing/feature-policy.ts`
- Create: `src/lib/billing/feature-policy.test.ts`

**Steps:**
1. RED: Bilinen Pro key → `pro`; bilinmeyen key → `unknown/default-deny` testleri.
2. Free ve Pro feature policy’lerini tek merkezde tanımla.
3. UI veya route’larda string plan key kontrolünü yasakla; yalnız semantic feature kontrolü kullan.
4. Bilinmeyen key için secret içermeyen structured log testini yaz.
5. Commit: `feat: define billing plan catalog`

### Task 7: `getMerchantLicence` adapter’ını ekle

**Objective:** Mağazanın uygulama aboneliğini ikas GraphQL üzerinden tenant-bound olarak okumak.

**Files:**
- Create: `src/lib/ikas/licence-adapter.ts`
- Create: `src/lib/ikas/licence-adapter.test.ts`
- Modify: `src/lib/ikas/errors.ts`

**Steps:**
1. RED: ACTIVE, WILL_BE_REMOVED, REMOVED, deleted ve başka app’e ait kayıt fixture’larını test et.
2. Query’de en az `authorizedAppId`, `storeAppListingSubscriptionKey`, `status`, `deleted`, `storeAppId` alanlarını al.
3. Authentication/network/GraphQL/invalid-response hatalarını typed error’lara map et.
4. `authorizedAppId` eşleşmeyen abonelikleri kesinlikle kabul etme.
5. Commit: `feat: read ikas app subscriptions`

### Task 8: Entitlement store ve resolver geliştir

**Objective:** Live licence sonucunu güvenli cache, grace ve invalidation davranışıyla özellik yetkisine çevirmek.

**Files:**
- Create: `src/lib/billing/entitlement-store.ts`
- Create: `src/lib/billing/entitlement-store.test.ts`
- Create: `src/lib/billing/entitlement-service.ts`
- Create: `src/lib/billing/entitlement-service.test.ts`

**Steps:**
1. RED: abonelik yok → Free; aktif bilinen key → Pro; bilinmeyen key → deny+alarm.
2. RED: başka tenant entitlement’ının kullanılamadığını test et.
3. RED: taze cache, stale cache, grace içi upstream hata ve grace sonu kapanma testlerini yaz.
4. Yeni yetki vermede fail-closed, doğrulanmış abonelikte bounded grace uygula.
5. Cache anahtarını `authorizedAppId` ile, trial kaydını `merchantId` ile partition et.
6. Commit: `feat: resolve server-side entitlements`

### Task 9: Ödeme webhook’unu cache invalidation’a bağla

**Objective:** `store/app/payment` geldiğinde sahte yetki üretmeden lisansı hızla yeniden doğrulamak.

**Files:**
- Modify: `src/app/api/webhooks/ikas/route.ts`
- Modify: `src/app/api/webhooks/ikas/route.test.ts`
- Modify: `src/lib/billing/entitlement-store.ts`

**Steps:**
1. RED: Yalnız `PAID`, doğru imzalı ve doğru app’e ait event’in işleme alındığını test et.
2. Event ID için Redis NX/idempotency tombstone uygula.
3. Event’teki plan key’i doğrudan yetki olarak kaydetme; entitlement cache’ini invalidate edip `getMerchantLicence` yenilemesini tetikle.
4. Duplicate webhook’un ikinci yan etki üretmediğini test et.
5. Commit: `feat: refresh entitlements after ikas payment`

### Task 10: Trial state machine ekle

**Objective:** Pro denemesini reinstall ile tekrar alınamayacak şekilde yönetmek.

**Files:**
- Create: `src/lib/billing/trial-store.ts`
- Create: `src/lib/billing/trial-store.test.ts`
- Modify: `src/lib/billing/entitlement-service.ts`
- Modify: `src/lib/billing/entitlement-service.test.ts`

**Steps:**
1. RED: İlk trial başlatma, bitiş, ikinci başlatma reddi ve uninstall/reinstall testleri.
2. Trial’ı `merchantId` ile anahtarla; yalnız `startedAt`, `expiresAt`, `consumed` gibi minimum alanları tut.
3. Trial kaydı immutable olsun; uninstall tenant sırlarını silsin ama trial tüketim kaydını silmesin.
4. Plan deneme süresi ile app-side `expiresAt` eşleşmesini development store’da doğrulama gate’i koy.
5. Commit: `feat: prevent repeated pro trials`

---

## Faz 2 — İlk faturalanabilir Pro değeri

### Task 11: Snapshot store ve diff motoru geliştir

**Objective:** Pro için merchant’ın manuel üretemeyeceği “yeni/çözülen sorunlar” değerini oluşturmak.

**Files:**
- Create: `src/lib/scans/snapshot-store.ts`
- Create: `src/lib/scans/snapshot-store.test.ts`
- Create: `src/lib/scans/report-diff.ts`
- Create: `src/lib/scans/report-diff.test.ts`
- Modify: `src/lib/ikas/report-service.ts`
- Modify: `src/lib/ikas/report-service.test.ts`

**Steps:**
1. RED: Yeni, devam eden ve çözülen issue kimliklerini iki snapshot arasında test et.
2. Stable issue identity tanımla: `productId + variantId? + ruleCode`.
3. Snapshot’a tam ürün payload’ı değil, rapor özeti ve minimum issue alanlarını yaz.
4. Tenant başına retention ve maksimum snapshot sayısını konfigüre et.
5. Aynı snapshot’ı JSON ve CSV endpoint’lerinde tekrar kullanarak CSV’nin ikinci tam tarama yapmasını önle.
6. Commit: `feat: persist health scan history and diffs`

### Task 12: Pro ayarları ve doğrulanmış e-posta alıcısı

**Objective:** İlk Pro sürümünde tek bir doğrulanmış bildirim adresi ve düşük stok eşiği toplamak.

**Files:**
- Create: `src/app/settings/page.tsx`
- Create: `src/app/settings/page.test.tsx`
- Create: `src/app/api/settings/route.ts`
- Create: `src/app/api/settings/route.test.ts`
- Create: `src/lib/notifications/recipient-store.ts`
- Create: `src/lib/notifications/recipient-store.test.ts`
- Modify: `src/app/page.tsx`

**Steps:**
1. RED: Free kullanıcı ayarı görebilir ancak ücretli schedule’ı aktive edemez.
2. Alıcı e-postasını tenant-scoped sakla; doğrulama linki tamamlanmadan gönderime izin verme.
3. Global düşük stok eşiğini açık ve doğrulanmış numeric sınırlarla kaydet.
4. Çoklu alıcı, ürün bazlı eşik ve Slack ekleme.
5. Commit: `feat: configure pro scan notifications`

### Task 13: E-posta bildirim servisi

**Objective:** Diff ve düşük stok sonuçlarını tek doğrulanmış alıcıya güvenli günlük özet olarak göndermek.

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/lib/notifications/email-service.ts`
- Create: `src/lib/notifications/email-service.test.ts`
- Create: `src/app/api/notifications/verify/route.ts`
- Create: `src/app/api/notifications/unsubscribe/route.ts`
- Modify: `src/globals/config.ts`

**Steps:**
1. RED: doğrulanmamış/unsubscribed alıcıya gönderim yapılmadığını test et.
2. Resend adapter’ını dependency-injected kur; testlerde ağ çağrısı yapma.
3. E-postaya yeni/çözülen sorun, düşük stok özeti ve dashboard linki koy; ürün datasını gereksiz çoğaltma.
4. Unsubscribe linkini zorunlu yap.
5. Tenant/gün idempotency key’i ile aynı gün çift e-postayı engelle.
6. Commit: `feat: send daily pro health summaries`

### Task 14: Vercel Cron günlük tarama worker’ı

**Objective:** Aktif Pro merchant’ları her gün güvenli ve idempotent biçimde taramak.

**Files:**
- Create: `src/app/api/cron/daily-scan/route.ts`
- Create: `src/app/api/cron/daily-scan/route.test.ts`
- Create: `src/lib/scans/scan-runner.ts`
- Create: `src/lib/scans/scan-runner.test.ts`
- Create: `src/lib/scans/installation-index.ts`
- Create: `src/lib/scans/installation-index.test.ts`
- Create: `vercel.json`
- Modify: `src/globals/config.ts`

**Steps:**
1. RED: `CRON_SECRET` olmayan/yanlış çağrı 401 ve sıfır yan etki.
2. Kurulum sırasında installation index’e ekleme, uninstall sırasında çıkarma testlerini yaz.
3. Her merchant öncesinde canlı `getMerchantLicence` doğrulaması yap; inactive merchant’ı tarama.
4. Per-merchant lease ve günlük idempotency key kullan.
5. Token refresh veya upstream hata durumunu dead-letter/last-run kaydına yaz; sessiz atlama yapma.
6. Başarılı taramada snapshot+diff kaydet, sonra e-posta gönder.
7. Commit: `feat: run scheduled pro health scans`

### Task 15: UI feature gating ve plan durumu

**Objective:** Free, Trial, Pro, Grace ve hata durumlarını kullanıcıya doğru ve manipüle edilemez biçimde göstermek.

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.test.tsx`
- Modify: `src/app/api/report/route.ts`
- Modify: `src/app/api/report/route.test.ts`
- Modify: `src/app/api/report.csv/route.ts`
- Create: `src/components/PlanStatusCard.tsx`
- Create: `src/components/ScanHistory.tsx`

**Steps:**
1. RED: Query/header/cookie ile `tier=pro` gönderilse bile Free kaldığını test et.
2. Free’de mevcut manuel tarama ve CSV’yi birebir koru.
3. Pro’da history/diff ve schedule durumunu göster.
4. Grace’de “abonelik doğrulanamadı” uyarısı; grace sonu ücretli özelliği kapat.
5. İkas native “Planı Yönet” akışına giden CTA’yı first-party desteklenen yöntemle bağla; undocumented URL hardcode etme.
6. Commit: `feat: gate pro monitoring features`

---

## Faz 3 — Partner paneli ve canlı satın alma kabulü

### Task 16: Partner plan konfigürasyonu

**Objective:** Free + Pro yıllık planı TR bölgesinde güvenli şekilde yayınlama taslağına eklemek.

**Partner actions:**
1. `product-health-pro-try-v1` anahtarlı Pro planı oluştur.
2. TRY fiyatını, yıllık ücreti ve doğrulanmış trial süresini gir.
3. Yayınlama sayfasında TR bölgesine Free + Pro’yu bağla.
4. Plan açıklamasında şunları açık yaz:
   - Ücretsiz manuel tarama ve CSV
   - Pro günlük tarama, history/diff, düşük stok eşiği, tek e-posta alıcısı
   - Yıllık fiyat ve kalan ikas lisans gününe göre prorasyon
   - Otomatik ürün/stok düzeltmesi yapılmadığı
5. Açıklama değişikliğinin yeniden inceleme gerektirdiğini hesaba kat; metni yayın öncesi dondur.

### Task 17: Development store satın alma matrisi

**Objective:** ikas’ın kendi satın alma ekranı, webhook ve licence query’sinin birlikte çalıştığını canlı kanıtlamak.

**Scenarios:**
- Free mağaza: subscription yok, manuel rapor/CSV açık, Pro cron kapalı.
- Pro trial: app-side trial state ve ikas plan süresi eşleşiyor.
- Pro purchase: `store/app/payment` → imza doğrulama → cache invalidation → live licence → Pro.
- Duplicate payment webhook: tek entitlement refresh, tek yan etki.
- Bilinmeyen plan key: deny + alarm.
- Licence upstream geçici hata: grace davranışı.
- Uninstall: token/entitlement/schedule/recipient siliniyor; trial tüketimi korunuyor.
- Reinstall: ikinci trial verilmiyor.
- Abonelik pasif/silinmiş: webhook olmasa da TTL/cron öncesi canlı kontrolle Pro kapanıyor.

**Evidence:** Her senaryoda timestamp, sanitized correlation ID, HTTP sonuçları ve UI ekran görüntüsü saklanacak; token/secret/payload signature rapora konmayacak.

### Task 18: Quality gates, review, PR ve preview

**Validation:**

```bash
pnpm test
pnpm test:e2e
pnpm lint
pnpm build
git diff --check
```

**Required additions:**
- Entitlement unit/integration tests
- Hostile-input tenant isolation tests
- Webhook signature/replay/idempotency tests
- Trial reinstall test
- Cron auth/idempotency tests
- Snapshot diff tests
- Email verification/unsubscribe tests
- Free regression E2E
- Pro mocked E2E; gerçek signed ikas launch ayrıca manuel gate

**Delivery:**
1. Bağımsız security/spec review.
2. Blocking bulguları düzelt ve bütün gate’leri yeniden çalıştır.
3. Feature branch + conventional commits.
4. PR aç, CI ve Vercel preview’ı doğrula.
5. Merge için kullanıcı onayı iste.
6. Production deploy sonrası signed ikas launch + development store satın alma smoke testini tekrar çalıştır.

---

## 4. Kabul kriterleri

### Entitlement

- [ ] Subscription kaydı olmayan merchant Free kalır.
- [ ] ACTIVE + `deleted=false` + doğru `authorizedAppId` + bilinen key yalnızca server-side Pro verir.
- [ ] İmzasız/yanlış imzalı `PAID` webhook yetki üretmez.
- [ ] Bilinmeyen key default-deny ve structured alarm üretir.
- [ ] Webhook olmadan abonelik sona ermesi TTL/cron doğrulamasıyla yakalanır.
- [ ] İstemci query/cookie/header ile tier değiştiremez.
- [ ] Başka tenant’ın entitlement/cache/snapshot/recipient verisi okunamaz.

### Trial ve uninstall

- [ ] Trial `merchantId` ile bir kez verilir.
- [ ] Uninstall/reinstall ikinci trial üretmez.
- [ ] Uninstall token, entitlement cache, schedule, recipient ve snapshot verisini temizler.
- [ ] Kaldırılmış mağaza için cron API çağrısı veya e-posta üretmez.

### Pro ürün değeri

- [ ] İki ardışık tarama yeni/çözülen sorunları doğru hesaplar.
- [ ] Düşük stok gerçek configurable threshold ile hesaplanır.
- [ ] Günlük tarama aynı merchant için aynı gün en fazla bir kez tamamlanır.
- [ ] Doğrulanmamış veya unsubscribe olmuş adrese e-posta gönderilmez.
- [ ] Cron secret olmadan çalışmaz.
- [ ] Hatalı cron çalışması dead-letter/last-run kaydı ve UI durumu üretir.

### Free regresyonu

- [ ] Mevcut canlı manuel tarama, kurallar, filtreler ve CSV Free’de korunur.
- [ ] Yeni billing bağımlılıkları ikas licence endpoint’i geçici olarak bozukken Free manuel raporu gereksiz yere kapatmaz.
- [ ] Ürün/stok/payment mutation scope’u eklenmez.

---

## 5. Riskler ve açık kararlar

1. **Webhook signature contract:** Algoritma first-party doğrulanmadan implementation/publish yapılamaz.
2. **Fiyat:** Gerçek merchant görüşmesi olmadan Partner paneline sabit fiyat girilmeyecek.
3. **Katalog limitleri:** Benchmark olmadan sayı seçilmeyecek; sessiz kısmi rapor yasak.
4. **Trial:** ikas plan trial davranışı development store’da canlı doğrulanmadan açılmayacak.
5. **E-posta compliance:** Doğrulama, unsubscribe, rate limit ve minimum PII saklama zorunlu.
6. **Upgrade yok:** İkinci ücretli tier şimdilik açılmayacak; plan key mapping versiyonlu kalacak.
7. **Grace süresi:** Teknik sabit değil ürün/güvenlik kararıdır; implementasyon öncesi net süre seçilecek ve test edilecek.
8. **Production scheduler kapasitesi:** Vercel Cron’ın tek invocation süresi ve merchant sayısı büyürse queue/worker mimarisi ayrı faz olacaktır; ilk MVP bounded batch ile başlamalı.

---

## 6. Önerilen uygulama sırası

```text
Faz 0: Ölçüm + gerçek low-stock + pagination sınırı + webhook contract + uninstall
  ↓
Faz 1: Plan catalog + getMerchantLicence + entitlement + payment webhook + trial
  ↓
Faz 2: Snapshot/diff + settings + email + cron + UI gating
  ↓
Faz 3: Partner plan konfigürasyonu + dev store purchase acceptance + PR/deploy
```

**Launch kararı:** İlk para testi ancak Free kullanıcı davranışı korunmuş, Pro’nun history/diff değeri çalışmış, uninstall temizliği ve canlı development-store purchase matrisi geçmişse verilecek.
