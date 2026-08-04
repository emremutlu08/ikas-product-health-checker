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

Pro is now resolved correctly — a store holding the plan is recognised as Pro (fixed in `405e108`,
verified live on `dev-emre4` and `dev-emre2`). That opens the gates. It does not mean any of the
promised behaviour has been seen to happen, and the two are recorded separately on purpose.

| Promise | Gate | Observed working |
| --- | --- | --- |
| Günde bir kez otomatik tarama | Open | **Yes** — see below. |
| Tarama geçmişi ve sorun farkları | Open | **Partly.** The scheduled runs above were taken under Pro, so they are retained rather than latest-only. The history surface itself has not been opened and compared yet. |
| Düşük stok eşiği ayarı | Open | **No.** The settings surface has never been exercised with a Pro entitlement. |
| Günlük e-posta özeti | **Closed** | **No.** `RESEND_API_KEY` and `IKAS_EMAIL_FROM` are set, but `mail.emre-mutlu.com.tr` is unverified in Resend, so nothing can be sent. |
| Düşük stok ve toparlanma bildirimleri | **Closed** | **No.** Same transport, same gap. |

### The scheduled scan, proven — 2026-08-04

```
08-04 10:00:28  claimed=2  scheduled=2  completed=2  sent=0  failed=0
```

Both installations were claimed, scanned and completed by the hourly cron, with no human involved.
`dev-emre4`'s dashboard independently shows `Son tarama: 04.08.2026 10:00`, matching that run.

Every other hour that day reported `skippedNotDue: 2`, which is the scheduler working as designed:
`MONITORING_INTERVAL_MS` is 23 hours, so a store scanned at 10:00 is not due again until the next
morning. That reading was only available because the run summary now names its skip reasons; before
that, twenty correct runs and a broken one produced identical output.

A caution for the next person reading production logs here: `vercel logs` retains roughly the last
four hours. A daily job is invisible in that window for most of the day, and its absence from the
log is not evidence that it did not run. Two hours were spent chasing an anomaly that was only a
gap in retention.

### What the plan screen may and may not claim — 2026-08-03

The capability badge is derived from configuration: `rolloutOf` reads feature flags and, for
history and the low-stock threshold, returns `available` unconditionally. It has no knowledge of
whether anything ever ran.

Beside it, the page told merchants that a capability is marked so *only once verified working in
production*. Three capabilities that had never executed once carried that badge. The claim was
removed in `696bb9a`; the label now reads "Planınızda açık" and the copy describes plan and setup
state rather than observed behaviour. A test pins both, because wording was the entire safeguard
and it had drifted with nothing to stop it.

If a badge is ever to mean "this ran", it needs a durable first-successful-run record to read. That
is not built, and until it is, the screen must not imply otherwise.

## Safety claims

| Claim | Status | Evidence |
| --- | --- | --- |
| "Ürün, stok ve fiyat bilgilerinizi değiştirmez" | Kept | `IKAS_PRODUCT_WRITES_ENABLED` and `IKAS_PRODUCT_BULK_WRITES_ENABLED` are both absent in production, and every correction path is closed when they are |
| "Ürün kataloğunuz e-postayla paylaşılmaz" | Kept | The daily summary body carries only score, state, counts and a `/history` link; no product name or identifier is ever included |
| "Düzeltme… geri alma imkânı sunar" | Kept, with a stated limit | A correction that filled a blank SKU is explicitly **not** offered as undoable, because writing a SKU back to empty has no proven inverse |

## Open gates before the first paying merchant

1. **Sender domain.** Verify `mail.emre-mutlu.com.tr` in Resend by publishing the MX and two TXT
   records it issues. Everything else for email is already configured. Closes when a cron run
   reports `sent: 1`.
2. ~~**A scheduled scan that actually runs.**~~ Closed 2026-08-04: `scheduled: 2, completed: 2`.
   What remains is opening the history surface and confirming two retained scans compare correctly.
3. **The low-stock threshold, exercised.** Set a threshold on a Pro store and confirm the next scan
   honours it.
4. **Multi-variant canary.** `updateProduct` writing one variant has never been proven to leave
   sibling variants alone. Needs a baseline SKU on a multi-variant product in `dev-emre2` and a
   live development token. `IKAS_PRODUCT_WRITES_ENABLED` stays closed until this is recorded here.
