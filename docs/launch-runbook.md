# Launch Runbook

The remaining steps between today and a provable Pro launch. Each one names the surface it happens
on, what to do there, and what counts as evidence afterwards. Nothing here is marked done until the
evidence exists — see [app-store-listing-promises.md](app-store-listing-promises.md) for why that
rule is enforced strictly.

Steps 1, 2 and 3 are independent and can run in parallel. Step 4 needs 2 and 3 finished first.

---

## 1. Canary baseline SKU

**Where:** `https://dev-emre2.myikas.com/admin` → Ürünler → `Premium Shorts` (24 variants)

1. Open the first variant. Its id is `3fc514c9-68e0-48da-934b-6e3ca2cf2dcd`; if the admin does not
   show ids, pick any variant and note which one.
2. Set its SKU to exactly `CANARY-BASE-1` and save.
3. Say "canary'yi çalıştır".

**Why a baseline is needed:** the canary rolls back by writing the old value, and the app's writer
types SKU as `string`. It cannot clear a SKU to empty — deliberately, because a correction that
filled a blank SKU has no proven inverse, which is also why the app refuses to offer undo for it.
Every variant in `dev-emre2` currently has `sku: null`, so there is nothing to roll back to.

**Evidence that closes this:** a canary run reporting `changedByWrite: []` and `changedOverall: []`
on a product with 24 variants, proving `updateProduct` writing one variant leaves the other 23
untouched. Only then may `IKAS_PRODUCT_WRITES_ENABLED` be opened.

---

## 2. Resend sender domain

**Where:** `https://resend.com/domains`, then your DNS provider for `emre-mutlu.com.tr`

1. Open the `mail.emre-mutlu.com.tr` entry, or add it with region `eu-west-1`.
2. Resend displays one MX record and two TXT records (SPF and DKIM). Copy the values it shows
   verbatim — do not reuse values from anywhere else.
3. Publish all three in the DNS panel. Watch the host field: many panels append the zone
   automatically, so entering the fully-qualified name produces a doubled hostname.
4. Return to Resend and press Verify. Propagation is usually minutes, occasionally an hour.
5. Say "resend hazır" once it turns green.

`RESEND_API_KEY` and `IKAS_EMAIL_FROM` are already set in Vercel Production. The domain is the last
missing piece: Resend rejects every send from an unverified domain.

**Evidence that closes this:** a cron run reporting `sent: 1`. Configuration alone proves nothing —
until a summary is actually delivered, the promise stays open.

---

## 3. A fresh development store

**Where:** `https://partners.ikas.com`

1. Create a new development store. Any name; `dev-emre4` is fine.
2. Add it to this app's allowlist:
   `https://partners.ikas.com/admin/application-details/ab00348e-4e4f-4ff7-a574-bc485cf7dc53/configuration`
   → **İzin Verilen Mağazalar** → **Mağaza Ekle**.
3. Load some products into it. A scan of an empty catalog proves nothing; ikas's sample products
   are enough.
4. Tell me the store name.

**Why a new store:** `dev-emre2` and `dev-emremutlu` already have the app installed under the free
option, and ikas does not let an installed store change plan
("Mağazaların aktif planlarını değiştirme özelliği henüz mevcut değildir"). ikas has asked that
`dev-emre3` be left untouched.

---

## 4. Install choosing Pro

**Where:** the new store's admin, `https://<store>.myikas.com/admin`

1. Install the app.
2. **In the plan step of the install flow, choose `Ürün Sağlığı PRO`, not the free option.** This is
   the only chance: a store that installs on free can never move to paid. That is exactly how
   `dev-emre2` became unusable for this test.
3. The 14-day trial starts; no card is charged.
4. Tell me it is done.

**What I verify afterwards, in order:**

1. `getMerchantLicence` returns a `storeAppListingSubscriptionKey` the plan catalog recognises.
2. The next hourly cron reports `scheduled: 1` or more — today it reports `scheduled: 0`, because
   the only installed store is on the free option, so the scheduled-scan path has never run.
3. The same run reports `sent: 1`, proving the email transport end to end. Step 2 above is its
   prerequisite.
4. Scan history, the low-stock threshold and the correction screen all exercised against a real
   entitlement.
5. Every result recorded in [app-store-listing-promises.md](app-store-listing-promises.md) and in
   the tracking issue.

---

## 5. The listing sentence, before the app is public

**Blocking. Nothing below matters if this one is skipped.**

The listing submitted for review says the app does not change product, stock or price information.
That stopped being true when the write flags opened, and ikas locks the publishing screen while an
app is `İnceleniyor`, so it could not be corrected on the spot.

What holds the risk today, checked in the Partner panel on 2026-08-10 rather than assumed: the app
is restricted to four allowed stores — `dev-emremutlu`, `dev-emre2`, `dev-emre3`, `dev-emre4` — all
Emre's own. No third party can install it, so no merchant is currently relying on that sentence.
The exposure is the reviewer, and ikas has been told directly.

**Where:** Partner Dashboard → the app → Yayınlama → Düzenlemeye Geç (enabled once the review ends)

The wording to paste is in
[app-store-listing-promises.md](app-store-listing-promises.md#the-safety-sentence-is-now-false--2026-08-07).

This was tried on 2026-08-10 and reverted within the hour: withdrawing a proven capability to
satisfy a sentence no merchant can currently read is the wrong trade. Both flags are open. The step
that actually has to happen is the wording, and the gate above is what stops the app reaching a
fifth store before it does.

**Evidence that closes this step:** the store page reads the new wording, and a screenshot or the
ikas reply saying so.
