# Codex Goal — Product Health Checker programını uçtan uca tamamla

## Rol ve çalışma biçimi

Sen bu repository'nin sorumlu senior product engineer'ısın. Görevin yarım durumdaki güvenli ürün operasyonları, bulk düzeltme ve düşük stok bildirim programını test-first biçimde tamamlamak; gerçek ikas development-store kanıtlarını toplamak; PR/CI/preview/production teslimatını bitirmek ve kullanıcıya uygulamanın gerçek **Free ve PRO** yeteneklerini tek bakışta göstermektir.

Repo:

- Local: `/Users/emremutlu/Apps/ikas-apps/ikas-product-health-checker`
- GitHub: `emremutlu08/ikas-product-health-checker`
- Tracking issue: <https://github.com/emremutlu08/ikas-product-health-checker/issues/16>
- Active branch: `feat/safe-product-operations`
- Development store: `dev-emre2`
- Merchant embedded route: `https://dev-emre2.myikas.com/admin/authorized-app/2bb51064-f76f-4d9a-9d90-9d333f7aad40`
- Production origin: `https://ikas-product-health-checker.vercel.app/`

Türkçe kullanıcı metni üret. Kod, identifier ve commit/PR başlıklarında mevcut repo dil ve convention'larını izle.

## Başlangıç durumu — bunu koru ve doğrula

Çalışma ağacı temiz bir checkpoint olarak branch'e kaydedildi ve remote'a push edildi. Temel implementation checkpoint'i `f1e67ebe58b423c0fcb2611819378a15474695f5` commit'idir; bunun üzerinde yalnız goal dokümanı düzeltme commit'leri bulunabilir. İlk iş olarak `git status`, `git diff`, branch/base SHA, remote tracking ve tracking issue #16'yı tekrar doğrula. Worktree temizse mevcut branch head'inden devam et. Codex çalışmaya başladığında yeni uncommitted değişiklikler varsa bunları kullanıcı/önceki agent çalışması say; incelemeden reset, clean, checkout, stash-drop veya overwrite ile silme.

Beklenen checkpoint alanları:

- `docs/ikas-mutation-contract.md`
- `docs/ikas-webhook-contract.md`
- `src/lib/ikas/mutation-preview*`
- `src/lib/ikas/product-adapter*`
- `src/lib/mutations/*`
- `src/lib/billing/feature-policy*`

Şu dilimler daha önce test edilmiştir; yine de güncel worktree üzerinde yeniden doğrula:

- Snapshot-bound SKU preview ve exact live product read
- 10 dakikalık tenant-bound confirmation preparation
- Redis/Lua operation state machine: `prepared → executing → succeeded/rejected/failed_unknown`
- Deletion barrier, replay block ve minimal audit
- Pro-only `product-corrections-write` feature
- Live stale/value preflight, tek writer çağrısı, exact read-back, no-blind-retry

Bunları olmuş varsayma; test ve diff ile kanıtla. Eksik/yanlışsa düzelt.

## Kaynak hiyerarşisi

1. Repository `AGENTS.md` talimatları zorunludur. Next.js 16 için kod yazmadan önce ilgili `node_modules/next/dist/docs/` belgelerini oku.
2. Resmî ikas MCP/SDK/Builders belgeleri şema ve davranış kaynağıdır.
3. `docs/ikas-mutation-contract.md`, `docs/ikas-webhook-contract.md`, `docs/live-ikas-gate.md`, `docs/ikas-licence-contract.md` mevcut doğrulanmış sınırları açıklar.
4. Belgelenmemiş provider davranışını tahmin etme. Runtime cast ile güvenme; untrusted payload'ları doğrula.
5. `docs/plan.md` içindeki eski “V1 read-only/no mutation” kararı tarihsel başlangıç kapsamıdır. Yeni onaylı programla çelişen bölümleri, güvenlik kapıları sağlandıktan sonra güncel gerçek duruma göre revize et; geçmişi sahte biçimde yeniden yazma.

## Değişmez güvenlik kuralları

- Tenant identity yalnız sealed installation session'dan gelir. Request body/query/header'dan tenant seçici kabul etme.
- OAuth access/refresh token'larını browser'a, log'a, audit payload'a, test snapshot'ına veya PR metnine koyma.
- Her write için live entitlement ve explicit feature grant zorunlu; unknown/inactive/mismatch fail-closed.
- Production merchant write yüzeyi ayrıca server-only global kill-switch ile default-off olsun.
- Preview client'a before/after gösterir; confirmation execution client'tan product/variant/value payload'ı değil yalnız opaque operation ID kabul eder.
- Confirmation kısa ömürlü, tek kullanımlık ve tenant-bound olmalı.
- Idempotency/claim ve tenant deletion barrier aynı durable atomic kararda kontrol edilmeli.
- Mutation öncesi exact live read ile product/variant/value/version doğrula.
- Mutation sonrası exact live read-back olmadan başarı deme.
- Timeout, transport failure veya belirsiz provider sonucu için kör retry yapma. Önce read-back reconciliation uygula.
- Audit minimal ve secretsiz olsun; token, full product payload, raw webhook body veya PII saklama.
- Rate limit: ikas için belgelenen `50 requests / 10 seconds` sınırının altında shared limiter, küçük concurrency ve `429` pause/circuit-breaker kullan.
- Stock mutation delta değil absolute quantity semantiğiyle tasarlanmalı; item-index errors kalıcı per-item sonuçlara çevrilmeli.
- Webhook signature algoritması yazma. Yalnız first-party `validateIkasWebhookSignature` ve `getParsedIkasWebhookData` kullan.
- Arbitrary merchant verisini canary olarak seçme veya değiştirme.

## Çalışma disiplini

Test-driven ilerle: her davranış için RED → minimal GREEN → refactor. Büyük yatay altyapı kurmadan önce dar çalışan tracer bullet üret. Her fazda ilgili unit/route/integration testlerini çalıştır. Hata alınca root cause bul; testleri silerek veya assertion gevşeterek yeşile dönme.

Tracking issue #16'yı durable source of truth olarak güncelle:

- aktif faz ve branch
- tamamlanan checklist
- head SHA
- test/CI run URL
- preview URL
- blocker
- rollback
- canlı acceptance kanıtı

Chat/terminal çıktısını tracking yerine kullanma.

## Faz 1 — Tekil SKU correction'ı production-safe tamamla

1. Mevcut preview ve operation-store kodunu review et; runtime validation, TTL, Redis parsing, state transition ve cleanup boşluklarını kapat.
2. Production Redis store factory/wiring ekle. Production'da memory fallback olmasın.
3. Mutation operation/audit kayıtlarını tenant uninstall cleanup'a ekle; deletion barrier yarışlarını test et.
4. Preview route ekle:
   - sealed installation session
   - same-origin/CSRF koruması
   - strict request schema
   - live active-PRO entitlement + `product-corrections-write`
   - opaque operation ID döndürme
   - sanitize error mapping
5. Confirmation route ekle:
   - body'de yalnız opaque operation ID
   - replay `409`
   - stale/value conflict `409` veya `412`
   - entitlement/kill-switch `403`
   - backend outage sanitize `503`
6. `HttpIkasProductAdapter` için allowlisted `updateProduct` writer ekle. Otomatik mutation retry yapma.
7. Exact preflight ve post-write read-back yap.
8. `succeeded`, `rejected`, `failed_unknown`, `verification_failed` ve reconciliation sonuçlarını minimal durable audit olarak sakla.
9. Process crash/timeout için reconciliation path ekle: write'ı tekrar etmek yerine live read-back ile operation'ı sonuçlandır.
10. Merchant UI'da before/after, expiry, açık confirmation, sonuç ve güvenli error state göster. Preview ekranı asla write yapmasın.
11. Undo/compensation yalnız exact post-state guard ile çalışsın; başka bir actor değeri değiştirmişse rollback'i reddet.

## Faz 2 — Development-store SKU canary

Gerçek write'tan önce:

1. `dev-emre2` üzerinde dedicated/safe test product ve variant bul.
2. Before snapshot çıkar: hedef ve korunması gereken omitted product/variant alanları.
3. Geçici SKU ve exact rollback SKU planını göster.
4. **Specific canary confirmation yoksa burada dur ve kullanıcıya exact product, variant, before, temporary value ve rollback değerini sor.** Daha önce verilmiş WRITE scope/saveApp onayı generic capability onayıdır; belirli merchant ürün mutation onayı değildir.
5. Onaydan sonra yalnız development store'da:
   - temporary SKU yaz
   - exact read-back ve omitted field/other variant diff kontrolü yap
   - rollback uygula
   - exact read-back ile başlangıç değerine döndüğünü kanıtla
6. Request/response'un secretsiz özeti, before/after/rollback diff'i ve timestamps tracking issue'a eklenmeli.
7. Tek-variant `updateProduct` diğer variant/alanları korumuyorsa public write yüzeyini açma; sözleşmeyi blocker olarak kaydet ve güvenli alternatif geliştir.

## Faz 3 — Tekil fiyat correction

SKU kanıtından sonra ayrı operation kind olarak geliştir:

- Preview → confirmation → claim → live guard → mutation → exact read-back → audit → guarded undo
- Resmî `updateVariantPrices` input/response şemasını MCP/SDK'dan yeniden doğrula.
- Fiyat objesini eksiksiz koru; para birimi, price list, sell/discount alanlarını yanlışlıkla silme.
- Decimal/rounding semantiğini explicit doğrula; float tahmin etme.
- Dedicated development-store fixture üzerinde temporary value + rollback acceptance yap.
- Specific price canary confirmation olmadan live price değiştirme.

## Faz 4 — Tekil stock correction

Fiyat kanıtından sonra ayrı operation kind olarak geliştir:

- Exact product/variant/stockLocation binding
- Absolute stock quantity semantiği
- Preview/confirmation/idempotency/audit/read-back/guarded undo
- `saveVariantStocks` item-index errors ve partial failure mapping
- Timeout/unknown result'ta blind retry yok; live reconciliation
- Dedicated development-store fixture ve temporary quantity + rollback
- Specific stock canary confirmation olmadan live inventory değiştirme.

## Faz 5 — Idempotent bounded bulk correction

Yalnız tekil operation acceptance kanıtları yeşil olduktan sonra:

1. Bulk preview/plan write yapmadan stable batch ID ve per-item operation/idempotency key üretsin.
2. Her item `ready | stale | invalid | skipped` sonucu taşısın.
3. Batch confirmation server-side plan hash'ine bağlı, expiring ve one-time olsun.
4. Küçük chunk, düşük concurrency, shared limiter, `429` pause ve circuit-breaker kullan.
5. Validation/stale terminal; timeout/unknown için önce read-back reconciliation.
6. Per-item `succeeded | rejected | failed_unknown` audit; partial success ve güvenli resume.
7. Resume tamamlanmış item'ı tekrar mutate etmesin.
8. Batch iptali yeni item başlatmayı durdursun; başlamış item'ı belirsiz bırakmasın.
9. Bulk undo ayrı confirmed batch olsun ve her item'ın exact current state'ini doğrulasın.
10. Unit, concurrency, replay, duplicate request, partial failure, rate-limit ve crash-recovery testleri yaz.

## Faz 6 — Salt-okunur düşük stok alert MVP

Mevcut günlük monitoring/settings/email altyapısını yeniden kullan; ikinci paralel sistem kurma.

1. Önce en dar production-ready değer: scheduled scan sonuçlarından **yeni threshold crossing** düşük stok durumlarını çıkar.
2. Tenant + product + variant + stock location için durable minimal alert state tut:
   - previous/current threshold side
   - firstSeen/lastSeen
   - lastNotified
   - recovery state
3. Duplicate scan aynı alert'i tekrar göndermesin.
4. Cooldown ve recovery notification davranışını testlerle tanımla.
5. Email/outbox idempotency ve kontrollü retry ekle; provider timeout'unda duplicate send riskini yönet.
6. Verified recipient sınırını koru; self-service recipient ancak güvenli verification flow varsa ekle.
7. Pro entitlement düşerse yeni alert gönderimini fail-closed durdur.
8. Uninstall cleanup'a alert state/outbox kayıtlarını ekle.
9. Stock webhook eklemek gerçekten MVP değerini artırıyorsa:
   - yalnız first-party SDK signature validation/parsing
   - strict scope schema
   - durable event ID dedupe
   - accepted scopes: `store/stock/created`, `store/stock/updated`
   - unknown ordering/retry/replay semantics'i dokümante et
   - live captured development-store delivery olmadan “verified” deme
10. Live webhook acceptance mümkün değilse polling tabanlı alert MVP'yi production-ready tamamla; webhook'u dürüstçe `pending/unverified` olarak bırak. Bu blocker bütün alert MVP'yi gereksiz yere durdurmasın.

## Faz 7 — Free / PRO yeteneklerini tek bakışta görünür yap

Kullanıcının ana teslimat beklentisi budur. Uygulamada canonical, testli bir capability catalog oluştur; UI metnini feature policy'den bağımsız hardcode ederek drift yaratma.

Minimum gerçek matris:

### Free

- Manuel canlı ürün sağlığı taraması
- Sağlık skoru ve issue dashboard'u
- En güncel tarama sonucu
- CSV dışa aktarma

### PRO

- Free'deki her şey
- Zamanlanmış/günlük tarama
- Tarama geçmişi ve yeni/devam eden/çözülen issue farkları
- Düşük stok threshold ayarı
- Günlük e-posta özeti
- Production acceptance'ı tamamlandıysa düşük stok crossing/recovery alertleri
- Production acceptance'ı tamamlandıysa güvenli tekil SKU/fiyat/stok correction
- Production acceptance'ı tamamlandıysa idempotent bounded bulk correction

Kurallar:

1. `feature-policy.ts` authorization için tek kaynak olmaya devam etsin.
2. Kullanıcı-facing label/description/status için type-safe capability catalog oluştur; her `APP_FEATURES` üyesinin tam bir UI kaydı olduğunu test et.
3. Dashboard veya uygun plan/settings yüzeyinde erişilebilir, responsive **Free vs PRO** karşılaştırma bölümü göster.
4. Kullanıcının aktif planını ve erişebildiği özellikleri net işaretle.
5. Henüz acceptance geçmemiş capability'yi “aktif” gibi gösterme. `Yakında`, `beta`, `kapalı` veya görünmez statüsünü gerçek rollout flag/policy'den türet.
6. Fiyatı kaynakta doğrulanmadıkça icat etme veya UI'ya koyma. `PRO_PLAN_KEY` fiyat değildir.
7. UI testleri Free/PRO metnini, coverage'ı ve unauthorized action'ların görünmemesi/disabled olmasını doğrulasın.
8. README/docs içinde aynı gerçek matrisi ve rollout durumunu yayınla.

## Route ve UI güvenlik kabul kriterleri

- Same-origin mutating requests
- Strict JSON content type/body size/schema
- No client-controlled tenant
- No client-controlled expected-before fields on confirmation
- No secrets in serialized props or logs
- Correct status/error mapping
- Accessible confirmation dialog; destructive-like consequences açık Türkçe metinle anlatılır
- Double-click, refresh, back/forward ve duplicate POST replay testleri
- Loading sırasında ikinci mutation başlatılamaz
- UI success yalnız server read-back success sonrası görünür
- Free/inactive/unknown entitlement write ve Pro-only alert ayarlarına erişemez

## Test ve kalite kapıları

Repo-local binary kullan; global `pnpm` wrapper build-script onayına takılırsa dependency/config dosyasını otomatik değiştirme. Önce mevcut local binary'leri kullan.

Her faz sonunda targeted testler; finalde en az:

```bash
./node_modules/.bin/vitest run
./node_modules/.bin/eslint .
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/next build --webpack
./node_modules/.bin/playwright test
```

Ek zorunlu test alanları:

- tenant crossing/mismatch
- deletion race
- Redis malformed payload/fail-closed
- operation expiry/replay/concurrent claim
- entitlement unknown/inactive/free
- kill-switch default-off
- stale product/variant/value
- writer timeout/no retry
- read-back mismatch
- reconciliation
- audit redaction
- bulk duplicate/resume/partial failure/rate limit
- alert crossing/dedupe/cooldown/recovery
- Free/PRO capability catalog completeness and UI

`git diff --check` çalıştır. Coverage sayısını raporla ama sadece sayıya güvenme.

## Review, PR, CI ve deployment

1. Değişiklikleri küçük, anlamlı commit'lere böl; secrets veya generated reports commit etme.
2. Fresh security/logic review yap; kritik/yüksek bulguları düzelt. Özellikle auth, tenant isolation, Lua atomicity, unknown mutation outcome ve webhook validation.
3. Branch'i push et ve issue #16'yı referanslayan PR aç.
4. PR açıklamasında:
   - scope
   - threat model/safety decisions
   - Free/PRO matrisi
   - test kanıtı
   - dev-store acceptance ve rollback kanıtı
   - unverified kalan provider davranışları
   - rollout flags
5. GitHub CI'ı izle; failure varsa root cause'u düzelt ve tekrar push et.
6. Preview deployment exact head SHA'yı doğrula; signed embedded app ve normal technical origin smoke/QA yap.
7. Base branch merge'in production auto-deploy ettiğini doğrula. Kullanıcıya bu coupling'i açıkça söylemeden merge etme.
8. Merge + production onayı alınmışsa merge et; exact merge SHA CI/deployment'ını izle, canonical production alias'ı doğrula, smoke ve runtime log kontrolü yap.
9. Production sorunu varsa feature kill-switch'i kapalı tut, gerekirse release commit'i revert et ve canary değerlerini recorded before state'e döndür.
10. Tracking issue #16'yı ancak bütün gerçek exit gate'ler geçtiğinde kapat.

## Otonomi ve durma koşulları

Kod okuma, test yazma, refactor, local test, docs, commit, push, PR, CI fix ve preview QA için kullanıcıya tekrar sorma; devam et.

Yalnız şu durumlarda dur ve exact kısa soru sor:

- dedicated development-store canary için specific product/variant/location ve before/temp/rollback onayı yoksa
- fiyat/stok gibi merchant verisine gerçek write yapılacaksa
- provider davranışı güvenli biçimde doğrulanamıyorsa ve write data loss riski varsa
- merge'in production auto-deploy etkisi henüz kullanıcıya açıklanıp onaylanmadıysa
- credential/payment/destructive işlem gerekiyorsa

CAPTCHA, password, API key veya ödeme bilgisi isteme/yazma. Browser auth gerekiyorsa mevcut authenticated profile'ı Playwright/Chrome ile güvenli kullan; secret değerleri kaydetme. MCP/CLI/API first, browser yalnız gerekli olduğunda.

## Tamamlanmış sayılma şartı

Aşağıdakilerin hepsi gerçek kanıtla sağlanmadan “tamamlandı” deme:

- SKU/fiyat/stok tekil güvenli operation'ları veya açıkça belgelenmiş provider blocker
- Specific dev-store canary + rollback kanıtı
- İdempotent bounded bulk veya tekil kanıt yetersizse dürüst blocker
- Production-ready polling tabanlı low-stock alert; webhook yalnız doğrulanmışsa aktif
- Uygulamada güncel, testli Free/PRO capability comparison
- Full test/lint/type/build/e2e green
- PR ve CI green
- Onay varsa merge + exact production deployment + smoke
- Issue #16 güncel
- Secretsiz final completion report

Final raporu Türkçe ve şu formatta ver:

1. **Durum**
2. **Teslim edilenler**
3. **Free yetenekleri**
4. **PRO yetenekleri**
5. **Güvenlik/idempotency kararları**
6. **Test kanıtı** — komutlar ve exact sonuçlar
7. **Canlı ikas kanıtı** — store, operation, before/temp/rollback; secretsiz
8. **PR/CI/deployment linkleri ve SHA'lar**
9. **Kalan gerçek blocker/unknown'lar**
10. **Rollback**
11. **Kullanıcıdan gereken tek sonraki adım** — yoksa `Yok`
