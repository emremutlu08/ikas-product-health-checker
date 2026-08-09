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
| "Ürün, stok ve fiyat bilgilerinizi değiştirmez" | **No longer kept — listing text must change** | Both write flags are now open in production (`2026-08-06`, `2026-08-07`). See below. |
| "Ürün kataloğunuz e-postayla paylaşılmaz" | Kept | The daily summary body carries only score, state, counts and a `/history` link; no product name or identifier is ever included |
| "Düzeltme… geri alma imkânı sunar" | Kept, with a stated limit | A correction that filled a blank SKU is explicitly **not** offered as undoable, because writing a SKU back to empty has no proven inverse |

### The safety sentence is now false — 2026-08-07

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

That leaves two honest options, both Emre's:

1. Apply the wording above the moment the review closes, before any merchant installs.
2. Write to `dev@ikas.com` during the review and say the safety sentence is now wrong. A draft:

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

1. ~~**Sender domain.**~~ Closed 2026-08-05: `mail.designdevjourney.com` verified. What remains is
   a run reporting `sent: 1`.
2. ~~**A scheduled scan that actually runs, and the diff that follows it.**~~ Closed
   2026-08-04 for the run (`scheduled: 2, completed: 2`) and 2026-08-09 for the comparison: seven
   retained scans, every entry with a predecessor showing its added/ongoing/resolved breakdown.
3. **The low-stock threshold, exercised.** Set a threshold on a Pro store and confirm the next scan
   honours it.
4. ~~**Multi-variant canary.**~~ Passed 2026-08-05 on a 24-variant product: writing one variant
   left the other 23 untouched, and the rollback restored the product exactly. Recorded in
   [live-ikas-gate.md](live-ikas-gate.md).
