# App Store Listing Promises vs. Evidence

Every claim the ikas App Store listing makes, and what actually backs it. A promise may only be
marked **kept** when there is evidence for it in this repository or in an observed production run —
"the code exists" is not evidence that a merchant receives the thing.

Reviewed 2026-07-28 against the listing text submitted for review.

## Free

| Promise | Status | Evidence |
| --- | --- | --- |
| Manuel katalog taraması | Kept | Live run on `dev-emre2`, 31 products scanned, recorded in [live-ikas-gate.md](live-ikas-gate.md) |
| Sağlık skoru ve sorun panosu | Kept | Same live run; score, rule cards and product table all rendered |
| CSV dışa aktarma | Kept | `issuesToCsv`, covered by unit tests and exercised in the live run |

### The rules the listing enumerates

All nine roll up into a merchant-visible rule card as of `463c903`. Before that commit the two
barcode faults were detected but never displayed, so the listing's barcode claim was not kept.

| Listing wording | Rule card | Issue codes |
| --- | --- | --- |
| Eksik SKU | SKU Eksik | `missing_sku` |
| Eksik barkod | Barkod Eksik | `missing_barcode` |
| Tekrarlanan SKU | Aynı SKU | `duplicate_sku` |
| Tekrarlanan barkod | Aynı Barkod | `duplicate_barcode` |
| Eksik görsel | Görsel Eksik | `missing_image` |
| Hatalı fiyat | Hatalı Fiyat | `missing_price` |
| Stokta olmayan aktif ürünler | Stokta Yok | `zero_stock_blocked` |
| Tekrarlanan başlık | Tekrarlanan Başlık | `duplicate_title` |
| Sorunlu açıklama | Sorunlu Açıklama | `missing_description`, `weird_description` |

`missing_category`, `missing_brand` and `missing_vendor` are still detected but deliberately reach
no rule card and no longer move the score. The listing does not mention them, and a number that
drops for a reason the merchant cannot find on screen is worse than no number at all.

## PRO

| Promise | Status | What is missing |
| --- | --- | --- |
| Günde bir kez otomatik tarama | **Verification pending** | `IKAS_MONITORING_SCHEDULER_ENABLED` was set to `true` and production redeployed on 2026-07-28. Until the cron's own log line turns from 503 into 200 this stays unproven — the flag being set is not evidence that a scan ran. |
| Tarama geçmişi ve sorun farkları | **Unproven live** | Implemented and Pro-gated. No store has ever held a Pro subscription, so this has never run against a real entitlement. |
| Düşük stok eşiği ayarı | **Unproven live** | Same. |
| Günlük e-posta özeti | **Half configured** | `RESEND_API_KEY` and `IKAS_EMAIL_FROM` now exist in Vercel Production, so `isDailySummaryEmailConfigured()` should pass. But the sender domain `mail.emre-mutlu.com.tr` is not yet verified in Resend, and Resend refuses to send from an unverified domain — so no summary reaches anyone yet. |
| Düşük stok ve toparlanma bildirimleri | **Half configured** | Same transport, same gap. |

### How the scheduler flag was read without reading the secret — 2026-07-29

`/api/internal/monitoring/daily` answers in a fixed order: a missing or wrong-length `CRON_SECRET`
gives 503, an unauthorized caller gives 401, and only then a scheduler flag that is not `"true"`
gives 503.

Production logs show both outcomes minutes apart:

```text
/api/internal/monitoring/daily  ->  503   Vercel cron, deployment URL, cache BYPASS
/api/internal/monitoring/daily  ->  401   unauthenticated probe from outside
```

The 401 proves the secret check passes, because an invalid secret would have answered 503 before
authorization was ever considered. So the cron's own 503 can only come from the last check, and
`IKAS_MONITORING_SCHEDULER_ENABLED` is not `"true"`. No environment variable was decrypted or
downloaded to establish this.

Nobody is harmed by the last four today: no store can subscribe to Pro yet, because ikas does not
support switching an installed store from the free option to a paid plan
("Mağazaların aktif planlarını değiştirme özelliği henüz mevcut değildir"). But the promises are in
the submitted listing, so they must be closed before the first Pro subscription exists.

## Safety claims

| Claim | Status | Evidence |
| --- | --- | --- |
| "Ürün, stok ve fiyat bilgilerinizi değiştirmez" | Kept | `IKAS_PRODUCT_WRITES_ENABLED` and `IKAS_PRODUCT_BULK_WRITES_ENABLED` are both absent in production, and every correction path is closed when they are |
| "Ürün kataloğunuz e-postayla paylaşılmaz" | Kept | The daily summary body carries only score, state, counts and a `/history` link; no product name or identifier is ever included |
| "Düzeltme… geri alma imkânı sunar" | Kept, with a stated limit | A correction that filled a blank SKU is explicitly **not** offered as undoable, because writing a SKU back to empty has no proven inverse |

## Open gates before the first Pro subscription

1. **Sender domain.** Verify `mail.emre-mutlu.com.tr` in Resend by publishing the MX and the two TXT
   records it issues. The API key and the from-address are already in Vercel Production; the domain
   is the only thing left, and Resend rejects every send until it is verified. Alternatively, drop
   the two email promises from the plan description.
2. **Scheduler proof.** The flag is set and production is redeployed. Watch the hourly cron's log
   line for `/api/internal/monitoring/daily` and record the first 200 here. A 503 there means the
   flag did not take, because an invalid `CRON_SECRET` would answer 503 *before* authorization and
   an unauthenticated probe answers 401.
3. **Multi-variant canary.** The recorded canary ran against a single-variant product, so
   `updateProduct` writing one variant has never been proven to leave *sibling variants* alone.
   Blocked on a live development token — the stored `dev-emre2` token now returns `LOGIN_REQUIRED`,
   and `dev-emre2` has no variant with a SKU to use as a rollback baseline.
4. **Live Pro run.** No store is available for this yet. `dev-emre2` and `dev-emremutlu` already
   have the app installed under the free option, and ikas does not let an installed store change
   plan; ikas has asked that `dev-emre3` be left untouched. A store must be agreed with ikas, then
   the app installed there choosing a paid plan *at install time*, before `getMerchantLicence` can
   be checked for a recognised `storeAppListingSubscriptionKey` and any write flag opened.
