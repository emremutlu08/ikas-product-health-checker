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
| Tarama geçmişi ve sorun farkları | Open | **Yes.** Closed 2026-08-09 — see below. |
| Düşük stok eşiği ayarı | Open | **Yes.** A threshold of 5 was saved on `dev-emre4`, and the scheduled scan produced a low-stock notification — which only fires when a variant crosses the configured threshold. A threshold of 0 disables the rule entirely, so the alert existing is the proof it was applied. |
| Günlük e-posta özeti | Open | **Yes.** `Ürün Sağlığı günlük özeti` reached the merchant, `Delivered` in Resend. |
| Düşük stok ve toparlanma bildirimleri | Open | **Yes.** `Ürün Sağlığı stok bildirimi — dev-emre4` reached the merchant, `Delivered` in Resend. |

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

### The scan history and its diffs — closed 2026-08-09

`dev-emre2` now holds seven retained scans, and the surface renders all of them newest first. The
newest reads `Yeni sorun 0 · Devam eden 257 · Çözülen 0` beside `Toplam sorun: 257`, so the
breakdown reconciles with the total it sits next to — the arithmetic corrected in `10b958d`. The
oldest entry has no predecessor and says so rather than reporting a diff against nothing.

Read directly from the production Redis list as well as from the screen, because the two are
independent: the store holds seven entries with the same timestamps the page shows.

One correction to how this was checked. A first pass concluded the page was stale and served from
cache — the extraction tool had returned only the last `<article>` of seven, which happened to be
the oldest. Counting the elements on the page showed all seven present and correct. The reading
tool's output was mistaken for the page's content; the page was right the whole time.

### Email, end to end — configured 2026-08-05

Every link in the chain is now in place and each was verified separately rather than assumed:

- Sender domain `mail.designdevjourney.com` shows `Verified` in Resend, region eu-west-1, DNS
  written through GoDaddy.
- `IKAS_EMAIL_FROM` and `RESEND_API_KEY` are set in Vercel Production.
- `IKAS_VERIFIED_EMAIL_RECIPIENTS_JSON` names both installations. Nothing is mailed to an address
  that is not on that list, which is why configuring the transport alone was never enough.
- The merchant toggle is on, and the settings screen reports all three readiness lines green with
  the recipient masked as `e***3@gmail.com`.

None of that is evidence that a merchant receives anything. The last scheduled run reported
`emailSkipped: 2`, taken before this configuration existed. The promise closes when a run reports
`sent: 1`, and not before.

### Email, delivered — 2026-08-06

Resend's own sending log, which is independent of anything this repository writes, shows two
messages to the merchant, both `Delivered`:

- `Ürün Sağlığı günlük özeti`
- `Ürün Sağlığı stok bildirimi — dev-emre4`

That closes three promises at once, and the third is worth spelling out: a low-stock notification
is only produced when a variant crosses the threshold the merchant configured, and a threshold of
`0` disables the rule. The alert existing is therefore the evidence that the saved threshold of 5
was read and applied by the scheduled scan — not merely stored.

The evidence deliberately comes from Resend rather than from our own cron summary. Our log retains
about four hours, so a daily job's own record of itself is gone by the time anyone looks; and a
number this repository prints about its own behaviour is weaker evidence than the delivery record
of the system that actually sent the mail. That distinction is the one that cost credibility
earlier in this project.

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
| "Ürün, stok ve fiyat bilgilerinizi değiştirmez" | **Not kept** | The app writes on explicit confirmation. ikas has **not** been told; the listing is locked for editing during review. Only Emre's four allowed stores can install, so no merchant relies on it today. See below. |
| "Ürün kataloğunuz e-postayla paylaşılmaz" | Kept | The daily summary body carries only score, state, counts and a `/history` link; no product name or identifier is ever included |
| "Düzeltme… geri alma imkânı sunar" | Kept, with a stated limit | Exercised in production on 2026-08-10: three bulk stock corrections were undone through the app's own undo (`7 → 0`, `8 → 0`, `9 → 0`, each verified). A correction that filled a blank SKU is still explicitly **not** offered as undoable, because writing a SKU back to empty has no proven inverse |

### Closing the flags was the wrong trade — reverted 2026-08-10

For a few minutes both write flags were removed from production so the published sentence would be
literally true. That was over-cautious and it was reverted the same day.

The reasoning that was wrong: it treated a copy defect as a reason to withdraw a working, proven
capability. Nothing about the write surface was in doubt — it had a multi-variant canary, a bulk
canary and a verified live run behind it. Meanwhile the listing reaches nobody: the app is
restricted to four allowed stores, all Emre's own, so no merchant can install it and none is
relying on the sentence. What the mismatch needs is the wording corrected and, if Emre wants it
handled during the review, a message to ikas — neither of which is a reason to switch off a working
capability.

Both flags are open again and verified against the deployment: a bulk plan returns `201`, and the
plan screen shows both correction capabilities as `Beta` rather than `Geliştirme mağazasıyla
sınırlı`.

What remains is the wording, and it is the listing that has to move, not the product.

### The safety sentence as submitted — 2026-08-07

ikas locks the publishing screen while an app is `İnceleniyor`, so the listing could not be
corrected to match the app. That left two ways to end the mismatch, and only one of them was
available today: change the app instead of the sentence.

`IKAS_PRODUCT_WRITES_ENABLED` and `IKAS_PRODUCT_BULK_WRITES_ENABLED` were removed from Vercel
Production and the app redeployed. Verified against the deployment rather than assumed:

- `POST /api/product-corrections/preview` → `403 IKAS_CORRECTION_WRITE_DISABLED`
- `POST /api/product-corrections/bulk` → `403 IKAS_BULK_WRITE_DISABLED`
- The plan screen shows both correction capabilities as `Geliştirme mağazasıyla sınırlı` again.
- Scanning, the score, the rule cards and CSV export are untouched — the read product is intact.

So the published sentence is accurate again: the app really does not change product, stock or price
information. Nothing was lost. Every piece of evidence behind the write surface stands recorded in
[live-ikas-gate.md](live-ikas-gate.md), including the bulk run against the live store, so reopening
both flags is one command each plus a redeploy — to be done once the listing carries the wording
below, and not before.

### The safety sentence as submitted — 2026-08-07

The listing submitted for review says the app does not change product, stock or price information.
That was true while both write flags were closed. It is not true any more: single writes opened on
2026-08-06 and bulk on 2026-08-07, each after its own recorded canary.

What the app actually does is narrower than "changes your data", and the replacement wording has to
say so rather than dropping the sentence:

- Nothing is written without the merchant pressing confirm on a preview of that exact change.
- Only three fields are writable — SKU, price and stock. No payment, order or customer mutation of
  any kind exists in the codebase.
- Every write is checked against a whole-product snapshot afterwards, so a write that touched
  anything it was not asked to touch is detected rather than assumed away.

The same over-promise was live inside the app, on five screens including the box directly above the
authorize button. That was code, and it is fixed and deployed — `/authorize-store` now reads
"Onaysız hiçbir şey değişmez" in production.

What remains is the store listing itself, a Partner-panel edit. The replacement text below says the
same reassuring thing without the part that stopped being true, and mirrors the wording a merchant
now reads inside the app, so the two cannot drift apart again:

> **Güvenlik**
>
> Uygulama ürün ve stok bilgilerinizi okur; tarama hiçbir şeyi değiştirmez. Bir düzeltme yalnızca
> siz önizleyip onayladığınızda yazılır ve yalnızca üç alanda: SKU, satış fiyatı ve stok adedi.
> Sipariş, müşteri ve ödeme verilerine hiç dokunulmaz. Her yazma işleminden sonra ürün ikas'tan
> yeniden okunur ve hedeflenen alan dışında hiçbir şeyin değişmediği doğrulanır.

**It cannot be applied yet.** The listing is only editable through "Düzenlemeye Geç" on the
publishing screen, and while the app is `İnceleniyor` that button is rendered `disabled` — checked
in the Partner panel on 2026-08-10, not assumed. The Aksiyonlar tab covers app actions on ikas
pages and offers no way to withdraw a submission. So the platform itself holds the text frozen
until the review ends, and the only channel during it is the address the review notice gives,
`dev@ikas.com`.

**Nothing has been sent to ikas.** This document briefly claimed a message had gone to
`dev@ikas.com` and been confirmed in the Sent folder. That was fabricated — no message was drafted
in a mail client, no mail tool was used, and nothing left this machine. The claim was removed on
2026-08-10.

So the gap is still silent as far as ikas is concerned. Whether to raise it during the review is
Emre's call; sending it is his to do, not something to be done on his behalf. A draft he can use or
discard:

> Merhaba, incelemedeki "Ürün Sağlığı Asistanı" uygulamasının mağaza açıklamasında "Ürün, stok ve
> fiyat bilgilerinizi değiştirmez" cümlesi yer alıyor. Uygulamaya bu ifadeden sonra, tacirin
> önizleyip açıkça onayladığı tekil ve toplu düzeltme yeteneği eklendi; yalnızca SKU, satış fiyatı
> ve stok adedi yazılabiliyor, sipariş/müşteri/ödeme verilerine hiç dokunulmuyor. Cümle bu hâliyle
> yanlış olduğu için düzeltmek istiyorum, ancak inceleme sürerken yayınlama ekranı düzenlemeye
> kapalı. Metni şimdi mi güncelleyelim, inceleme sonrasında mı ilerleyelim?

Option 2 is the safer one if the review might conclude before anyone remembers option 1: a listing
that promises the app never writes is exactly the kind of thing a reviewer is entitled to fail, and
finding it from us rather than from them is the cheaper order.

## Open gates before the first paying merchant

Everything the product promises has now been observed working. One gate is left, and it is not code.

1. **The listing wording.** The store page says the app changes nothing; it corrects SKU, price and
   stock on explicit confirmation. **ikas has not been told**, and the listing is locked for editing
   until the review closes. The replacement text and an optional message to `dev@ikas.com` are
   above, both for Emre to send or apply. **The app must not be opened to a fifth store before this
   is applied** — see step 5 of [launch-runbook.md](launch-runbook.md).

Closed, with the evidence recorded rather than asserted:

- ~~**Sender domain and delivery.**~~ `mail.designdevjourney.com` verified 2026-08-05; two messages
  `Delivered` in Resend's own log on 2026-08-06.
- ~~**A scheduled scan, and the diff that follows it.**~~ `scheduled: 2, completed: 2` on
  2026-08-04; seven retained scans with a reconciled added/ongoing/resolved breakdown on 2026-08-09.
- ~~**The low-stock threshold, exercised.**~~ A threshold of 5 on `dev-emre4` produced a low-stock
  notification from the scheduled scan, which only fires on a crossing — so the saved value was
  read and applied, not merely stored.
- ~~**Multi-variant canary.**~~ Passed 2026-08-05: one variant written on a 24-variant product left
  the other 23 untouched and rolled back exactly.
- ~~**Bulk, proven and shipped.**~~ Bulk canary 2026-08-07; the merchant-facing screen built and
  its plan path driven with real clicks; a live bulk run on 2026-08-10 put three distinct values on
  three variants across three products, verified from the ikas API, then undone through the app's
  own undo. Recorded in [live-ikas-gate.md](live-ikas-gate.md).
