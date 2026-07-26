# Claude Code Completion Goal — Product Health Checker

## Amaç

`ikas-product-health-checker` uygulamasındaki yarım güvenli ürün operasyonları, düşük stok bildirimleri, bulk correction ve Free/PRO ürünleştirme programını uçtan uca tamamla; gerçek test, canary, CI ve deployment kanıtlarıyla teslim et.

Bu dosya Claude Code için execution entrypoint'tir. Ürün kapsamının authoritative ayrıntılı kaynağı `docs/codex-completion-goal.md` dosyasıdır. Dosya adı geçmişte Codex için oluşturulmuş olsa da içindeki bütün sorumluluklar Claude Code için de bağlayıcıdır.

## 1. Çalışma alanı ve yetki sınırı

Yalnız şu repository üzerinde çalış:

`/Users/emremutlu/Apps/ikas-apps/ikas-product-health-checker`

GitHub repository:

`emremutlu08/ikas-product-health-checker`

Başka hiçbir repository'ye, özellikle Aloo projelerine dokunma.

İlk olarak sırasıyla şunları baştan sona oku:

1. Root `AGENTS.md`
2. Bu dosya: `docs/claude-code-completion-goal.md`
3. `docs/codex-completion-goal.md`
4. `docs/ikas-mutation-contract.md`
5. `docs/ikas-webhook-contract.md`
6. GitHub issue #16

Bu dosya execution ve temiz teslimat kurallarını; `docs/codex-completion-goal.md` ürün kapsamını belirler. Çelişki varsa güvenlik bakımından daha sıkı olan kuralı uygula. Gerçek platform davranışında repository'deki güncel ikas sözleşmesi ve birinci taraf kaynaklar esastır; tahmin yürütme.

## 2. Başlangıç durumu

Beklenen branch:

`feat/safe-product-operations`

Doğrulanmış implementation baseline/head:

`25e6982b801c1a9395e6929bb003a6d0c0b21103`

Bu Claude entrypoint dosyasını ekleyen bir veya daha fazla docs-only commit bunun üzerinde bulunabilir. Mevcut branch head'inden devam et.

Beklenen ana dal tabanı:

`9748111bee913c768df04dec0d115cb39303a403`

Beklenen başlangıç özellikleri:

- Worktree temizdir.
- Branch remote'a push edilmiştir.
- Local ve remote branch senkrondur.
- Açık completion PR'ı yoktur.
- Branch main'den ileridedir.
- Mevcut güvenli mutation checkpoint'i commitlidir.

İlk komutlarda bunları yeniden doğrula:

- `git status`
- branch ve remote tracking
- local/remote SHA
- origin/main farkı
- açık PR'lar
- GitHub issue #16

Tutarsızlık varsa kök nedenini araştır. Kullanıcı veya önceki agent çalışmasını silme.

## 3. Understanding Check ve özerk çalışma

Dosyaları okuduktan sonra kendi cümlelerinle kısa bir Understanding Check yaz:

- mevcut production durumu,
- feature branch'teki tamamlanmış temel,
- kalan ürün kapsamı,
- değişmez güvenlik kuralları,
- dış safety gate'leri,
- completion koşulları.

Ardından güvenlik veya dış sistem safety gate'i dışında soru sormadan uygula. Goal'u daha küçük bir kapsama indirgeme. Yalnız kolay kısmını tamamlayıp kalanları `future work` olarak bırakma.

Gerektiğinde subagent kullan:

- security review,
- API contract review,
- logic review,
- UI/UX review,
- test review.

Subagent iddiasını kendin gerçek repo ve komutlarla doğrulamadan kanıt kabul etme.

## 4. Git ve temizlik disiplini

Repository her anlamlı checkpoint'te temiz olmalıdır.

Yap:

- Her bağımsız, testli iş paketini conventional commit ile kaydet.
- Yalnız ilgili dosyaları stage et.
- Her commit öncesinde ilgili testleri ve `git diff --check` çalıştır.
- Secret/credential taraması yap.
- Her safety gate öncesinde bütün doğrulanmış değişiklikleri commit et ve push et.
- Safety gate'te branch'i local/remote senkron ve worktree'yi temiz bırak.
- Geçici credential/env dosyalarını repo dışında oluştur ve iş bitince sil.
- Session sonunda untracked, modified, staged veya stash edilmiş değişiklik bırakma.

Yapma:

- `git reset --hard`
- `git clean`
- force push
- geçmişi yeniden yazan rebase
- stash drop
- kullanıcı değişikliklerini overwrite eden checkout
- doğrulanmamış branch silme
- broad ve incelemesiz `git add .`
- secret, token, connection string veya merchant payload commit etme
- build artifact, browser state veya env dump commit etme

## 5. Çalışma yöntemi

Senior product engineer ve security-conscious maintainer olarak davran.

- Test-driven development uygula.
- Önce başarısız test, sonra minimum implementation, sonra refactor.
- Mevcut mimari ve repository convention'larını kullan.
- Genel amaçlı katalog editörü oluşturma.
- Yalnız doğrulanmış, allowlist edilmiş mutation yüzeyleri oluştur.
- Çalıştırılmayan testi çalışmış gibi gösterme.
- API, CI, browser veya deployment sonucu uydurma.
- Bir yöntem başarısız olursa alternatif CLI/API/MCP yaklaşımını dene.
- CLI/API/MCP'yi browser'a tercih et.
- Browser zorunlu fakat araç yoksa işlemi yapılmış gibi gösterme; exact blokajı bildir.

## 6. Tamamlanacak kapsam

`docs/codex-completion-goal.md` içindeki bütün kapsamı tamamla. Minimum teslimat şunları içerir:

### Güvenli tekil product operation

- Snapshot-bound preview
- Exact issue doğrulaması
- Opaque, tenant-bound, expiring confirmation
- Atomic claim
- Replay/duplicate engelleme
- Tenant deletion fencing
- Live entitlement ve permission
- Live product/variant read
- Product timestamp ve previous-value stale guard
- Allowlist writer
- Source-of-truth read-back
- Durable secretsiz audit
- Uncertain-result reconciliation
- Kör retry yasağı
- Guarded undo/rollback

### SKU

- Exact product/variant SKU correction
- Preview ve explicit confirmation
- Read-back
- Stale/conflict/uncertain handling
- Reversible dev-store canary

### Fiyat

- Full live price collection read
- Full-object preservation
- Güvenli merge
- Currency/price-list/tax/rounding varsayımı yapmama
- Preview, confirmation, read-back
- Reversible canary

### Stok

- Exact stock location
- Mutlak `stockCount`
- Duplicate ve race modeli
- Item-level errors
- Preview, confirmation, read-back
- Reversible/compensating canary

### Merchant-facing API/UI

- Preview/prepare route
- Confirmation/execution route
- Reconciliation
- Undo/rollback
- Session-bound installation identity
- Same-origin/CSRF
- Güvenli error mapping
- Before/after UI
- Explicit confirmation
- Replay/stale/expired/conflict/uncertain durumları
- Accessibility ve E2E

### Düşük stok bildirimleri

- Crossing
- Recovery
- Durable state
- Event dedupe
- Replay/timestamp policy
- Cooldown
- Outbox
- Retry/backoff
- Verified recipient
- Tenant fencing
- Polling/event ortak state modeli
- Official SDK signature/parsing
- Invalid signature rejection

Webhook sözleşmesi güvenli biçimde kanıtlanamazsa bunu gerçek zamanlı diye sunma. Production-ready polling fallback'i açıkça adlandır.

### Bulk correction

Tekil mutation modeli ve development-store canary kanıtlanmadan bulk açma.

Bulk tamamlandığında:

- Dry-run
- Stable per-item idempotency key
- Shared rate limiter
- Bounded chunking/concurrency
- 429 pause/retry policy
- Validation error isolation
- Circuit breaker
- Partial success audit
- Unknown-result reconciliation
- Safe resume
- Per-item read-back
- Explicit confirmation
- Tenant deletion fencing

## 7. Free ve PRO capability matrix

Merchant-facing açık bir Free/PRO karşılaştırma yüzeyi oluştur.

Tek canonical capability catalog kullan. Backend entitlement, feature policy ve UI metni birbirinden kopuk hardcoded listeler olmamalıdır.

### Free

- Manuel katalog taraması
- Mağaza sağlık skoru
- Ürün sorunları dashboard'u
- En güncel tarama sonucu
- CSV dışa aktarma

### PRO

Free'deki her şeye ek olarak, acceptance durumuna göre:

- Tarama geçmişi
- Yeni/devam eden/çözülen sorun farkları
- Zamanlanmış günlük tarama
- Düşük stok threshold ayarı
- Doğrulanmış günlük e-posta özeti
- Crossing/recovery bildirimleri
- Güvenli tekil SKU correction
- Güvenli tekil fiyat correction
- Güvenli tekil stok correction
- Guarded rollback/undo
- Idempotent bulk correction

Acceptance geçmemiş özellik aktifmiş gibi gösterilemez. Gerekiyorsa `Beta`, `Yakında`, `Kapalı` veya `Development-store ile sınırlı` olarak göster.

Kaynaktan doğrulanmış fiyat, currency, billing interval, trial, checkout veya Marketplace acceptance yoksa bunları uydurma. Internal PRO entitlement'ı satın alınabilir Marketplace planı gibi sunma.

Capability matrix için unit ve browser/E2E testleri yaz.

## 8. Değişmez güvenlik kuralları

- Installation identity yalnız sealed server session'dan gelir.
- Tenant identity request body'den gelmez.
- Merchant exact değişikliği açıkça onaylar.
- Permission ve entitlement birbirinin yerine geçmez.
- Preview mutation yapmaz.
- Confirmation tek kullanımlıdır.
- Atomic claim olmadan write yapılmaz.
- Stale baseline'da write yapılmaz.
- Kör retry yapılmaz.
- API success tek başına başarı değildir.
- Source-of-truth read-back zorunludur.
- Audit token, secret veya full merchant payload içermez.
- Uninstall/deletion sonrası background write yapılmaz.
- Webhook signature algoritması yeniden yazılmaz.
- Resmi SDK verification boundary kullanılır.
- Feature flag ve kill switch olmadan public write surface açılmaz.
- Canary tamamlanmadan production write flag açılmaz.
- Rastgele merchant ürünü üzerinde test yapılmaz.

## 9. Development-store canary safety gate

Kod, offline testler, Redis acceptance ve preview QA tamamlanmadan gerçek merchant mutation'ı isteme.

`dev-emre2` üzerinde gerçek SKU, fiyat veya stok değişikliği çalıştırmadan önce dur. Kullanıcıya tek ve net bir onay sorusu sor. Soruda mutlaka şunlar olsun:

- store,
- exact product ID ve görünen ürün adı,
- exact variant ID ve görünen varyant adı,
- varsa stock location,
- mevcut değer,
- geçici test değeri,
- rollback değeri,
- değişecek exact alan,
- değişmeyecek ve karşılaştırılacak alanlar,
- beklenen etki,
- read-back planı,
- rollback planı.

Açık onay olmadan gerçek SKU, fiyat veya stok mutation'ı çalıştırma.

Onaydan sonra:

1. Before snapshot al.
2. Exact mutation'ı yalnız bir kez çalıştır.
3. Source-of-truth read-back yap.
4. İlgisiz alanların değişmediğini doğrula.
5. Rollback yap.
6. Rollback read-back yap.
7. Before/final eşleşmesini doğrula.
8. Secretsiz acceptance kanıtı oluştur.
9. Belirsiz sonuçta kör retry yapma.

Güvenli canary yapılamayan capability'yi production-ready sayma ve aktif gösterme.

## 10. Test ve kalite kapıları

Final öncesinde repository-local binary'lerle şunların tamamını çalıştır:

```bash
./node_modules/.bin/vitest run
./node_modules/.bin/eslint .
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/next build --webpack
./node_modules/.bin/playwright test
```

Ayrıca:

- Redis Lua script'lerini disposable gerçek Redis üzerinde çalıştır.
- Atomic claim yarış testi yap.
- Replay testleri yap.
- Permanent deletion barrier acceptance testi yap.
- Tenant isolation testleri yap.
- Invalid webhook signature testi yap.
- Duplicate webhook testi yap.
- Crossing/recovery testleri yap.
- Rate-limit ve bulk testleri yap.
- Undo/rollback testleri yap.
- Capability matrix E2E testi yap.
- `git diff --check` çalıştır.
- Secret/credential scan çalıştır.
- Fresh security review yap.
- Fresh logic review yap.
- Reviewer bulgularını düzelt.
- Düzeltmelerden sonra full kalite kapılarını yeniden çalıştır.

Next.js development/E2E server gerekiyorsa webpack kullan.

Testleri bypass etme, skip ile yeşile çevirme veya expectation'ı hatalı implementation'a uydurma.

## 11. GitHub ve teslimat

GitHub issue #16'yı durable tracker olarak güncel tut.

Production-ready olduğunda:

1. Bütün değişikliklerin commitli olduğunu doğrula.
2. Branch'i push et.
3. Issue #16'ya bağlı PR oluştur.
4. PR body'ye summary, Free/PRO matrix, security guarantees, test/Redis/canary kanıtı, feature flags, rollout ve rollback planı koy.
5. CI'yı izle ve kök nedenli düzelt.
6. Preview deployment'ı doğrula.
7. Merchant-facing Free/PRO UI'yı browser/E2E ile doğrula.
8. Fresh final review yap.

Bu goal commit, push, issue update, PR oluşturma ve CI düzeltme yetkisi verir.

Aşağıdakiler ayrı external safety gate'tir:

- gerçek merchant SKU/fiyat/stok mutation'ı,
- production write feature flag açılması,
- production/main merge.

Bu noktalarda değişiklik, kanıt ve etkiyi tek mesajda sunarak açık onay iste.

Merge onayı sonrasında:

1. PR'ı merge et.
2. Exact production deployment'ı doğrula.
3. Production origin smoke testlerini çalıştır.
4. Gerekirse embedded `dev-emre2` akışını doğrula.
5. Local repository'yi `main` branch'ine geçir.
6. `origin/main` ile fast-forward/pull yap.
7. Merge edilmiş local ve remote feature branch'i güvenli biçimde sil.
8. Son durumda local branch `main`, local main = origin/main, worktree temiz, stash boş ve açık completion PR'ı yok olduğunu doğrula.

Merge safety gate'inde durursan feature branch'i temiz, commitli ve remote ile senkron bırak.

## 12. Completion tanımı

Kod yazılması tek başına completion değildir.

Goal ancak aşağıdakilerin tamamı doğruysa tamamlanmıştır:

- Authoritative goal kapsamı uygulanmış
- Güvenlik invariants korunmuş
- Full kalite kapıları yeşil
- Redis acceptance geçmiş
- Fresh review temiz
- Development-store canary ve rollback kanıtlanmış
- Free/PRO matrix gerçek capability durumunu gösteriyor
- PR ve CI tamamlanmış
- Preview doğrulanmış
- Onay sonrasında production merge/deployment tamamlanmış
- Production smoke geçmiş
- Final Git state tamamen temiz
- Local main origin/main ile senkron

External safety gate nedeniyle duruyorsan `tamamlandı` deme. `Onay bekliyor` olarak raporla ve exact sonraki adımı belirt.

## 13. Final rapor

Final raporu Türkçe ver:

1. Understanding Check
2. Tamamlanan kapsam
3. Free paket yetenekleri
4. PRO paket yetenekleri
5. Beta/kapalı/ertelenen özellikler
6. Güvenlik ve tenant izolasyonu
7. Test sonuçları ve exact sayılar
8. Redis acceptance
9. Development-store canary
10. Rollback kanıtı
11. PR ve CI
12. Preview ve production deployment
13. Production smoke sonucu
14. Değişen dosyalar
15. Commitler
16. Bilinen riskler
17. Marketplace/ticari sonraki adımlar
18. Final Git durumu

Her iddianın yanında gerçek komut, test, API, GitHub, deployment veya browser kanıtı olmalıdır. Kanıtlanamayan şeyi tamamlanmış gibi sunma.

## Başla

Şimdi `AGENTS.md`, bu dosya ve `docs/codex-completion-goal.md` başta olmak üzere belirtilen kaynakları oku. Understanding Check'i yaz. Goal tamamlanana veya tanımlı external safety gate'e ulaşana kadar autonomously ilerle.