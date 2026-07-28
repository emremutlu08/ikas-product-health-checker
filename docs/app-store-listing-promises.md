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
| Günde bir kez otomatik tarama | **Unverified** | Cron is configured in [vercel.json](../vercel.json), but the production value of `IKAS_MONITORING_SCHEDULER_ENABLED` has not been read. Reading it requires pulling production secrets, which is not done from an agent session. |
| Tarama geçmişi ve sorun farkları | **Unproven live** | Implemented and Pro-gated. No store has ever held a Pro subscription, so this has never run against a real entitlement. |
| Düşük stok eşiği ayarı | **Unproven live** | Same. |
| Günlük e-posta özeti | **Not deliverable** | Production has no `RESEND_API_KEY` and no `IKAS_EMAIL_FROM`, so `isDailySummaryEmailConfigured()` returns false and no summary can be sent. |
| Düşük stok ve toparlanma bildirimleri | **Not deliverable** | Same transport, same gap. |

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

1. **Email transport.** Provision Resend and set `RESEND_API_KEY` + `IKAS_EMAIL_FROM` in Vercel
   Production, or remove the two email promises from the plan description.
2. **Scheduler flag.** Read `IKAS_MONITORING_SCHEDULER_ENABLED` in the Vercel dashboard and record
   the value here. Until then "günde bir kez otomatik tarama" stays unverified.
3. **Multi-variant canary.** The recorded canary ran against a single-variant product, so
   `updateProduct` writing one variant has never been proven to leave *sibling variants* alone.
   Blocked on a live development token — the stored `dev-emre2` token now returns `LOGIN_REQUIRED`,
   and `dev-emre2` has no variant with a SKU to use as a rollback baseline.
4. **Live Pro run.** Subscribe a store to Pro at install time (`dev-emre3` is allowed and unused)
   and confirm `getMerchantLicence` returns a `storeAppListingSubscriptionKey` the plan catalog
   recognises, before opening any write flag.
