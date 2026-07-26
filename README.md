# ikas Ürün Sağlığı Asistanı

ikas admin app that scans a merchant's catalog for product-health problems and — behind an
explicit, reversible, default-off write surface — offers safe single-field corrections.

## Current status

- Live `listProduct` catalog scan, health score, issue dashboard and CSV export are shipped.
- Scheduled scans, scan history, low-stock threshold and the daily e-mail summary are Pro features.
- Low-stock threshold crossing and recovery notifications ship as a **polling** MVP derived from
  the scheduled scan. No webhook receiver exists; nothing is presented as real-time.
- Safe single SKU, price and stock corrections and idempotent bulk correction are implemented and
  offline-accepted, and are **switched off**. They open only after a reversible development-store
  canary proves that a single-variant `updateProduct` leaves every other field untouched.
- The app performs no payment, order or customer mutation of any kind.

## Free and PRO capabilities

This table mirrors `src/lib/billing/capability-catalog.ts`, which derives each row's required tier
from `src/lib/billing/feature-policy.ts` — the same policy the routes enforce. Status is the real
rollout state, not an aspiration.

| Capability | Free | PRO | Status |
| --- | :---: | :---: | --- |
| Manual catalog scan | ✓ | ✓ | Available |
| Health score and issue dashboard | ✓ | ✓ | Available |
| CSV export | ✓ | ✓ | Available |
| Scheduled daily scan | — | ✓ | Needs operator configuration (`IKAS_MONITORING_SCHEDULER_ENABLED`) |
| Scan history and new/ongoing/resolved diffs | — | ✓ | Available |
| Low-stock threshold setting | — | ✓ | Available |
| Daily e-mail summary | — | ✓ | Needs scheduler, mail provider and a verified recipient |
| Low-stock crossing and recovery notifications | — | ✓ | Beta, polling-based; needs the scheduler |
| Safe single SKU / price / stock correction | — | ✓ | **Development-store limited** until the canary passes |
| Idempotent bulk correction | — | ✓ | **Development-store limited** until the canary passes |

No price, currency, billing interval or trial appears anywhere in this app or this table. None has
been verified from a first-party ikas source, and `PRO_PLAN_KEY` is a Partner-panel listing key,
not a price.

### Rollout switches

| Variable | Effect |
| --- | --- |
| `IKAS_PRODUCT_WRITES_ENABLED` | Server-only kill switch for every correction and its preview. Default off. |
| `IKAS_PRODUCT_BULK_WRITES_ENABLED` | Additionally gates bulk; also requires the switch above. |
| `IKAS_MONITORING_SCHEDULER_ENABLED` | Enables scheduled scans, and with them low-stock alerting. |

## Verified ikas MCP facts

`listProduct` is available with pagination (`limit` max 200, `page`, `hasNext`) and exposes product/variant fields needed for the first report:

- product: `id`, `name`, `brand`, `vendor`, `categories`, `tags`, `description`, `shortDescription`, `metaData`, `totalStock`, `type`, `deleted`, `variants`
- variant: `id`, `sku`, `barcodeList`, `images`, `isActive`, `sellIfOutOfStock`, `prices`, `stocks.stockCount`, `stocks.stockLocationId`, `deleted`

`createMerchantAppPayment` exists, but payment lifecycle is intentionally out of v1 scope.

## Commands

```bash
pnpm install
pnpm exec playwright install chromium
pnpm test
pnpm test:e2e
pnpm test:all
pnpm lint
pnpm build
pnpm dev
```

Chromium kurulumu temiz checkout başına bir kez gerekir. Linux CI, gerekli sistem paketlerini de kurmak için `pnpm exec playwright install --with-deps chromium` komutunu kullanır.

`pnpm test:e2e` starts an isolated local Next.js server and runs Chromium smoke coverage for the installation-required screen, store-name normalization, safe OAuth failure rendering, and tenant-protected report endpoints. It does not replace the signed ikas launch check against a real development store.

The `.github/workflows/quality.yml` workflow runs `pnpm test:all`, lint, and the production build for every pull request and every push to `main`.

## V1 scope

- Missing SKU
- Missing barcode
- Duplicate SKU
- Duplicate barcode
- Missing images
- Missing description
- Missing category
- Missing brand/vendor
- Zero stock with out-of-stock selling disabled
- Missing/invalid sell price
- CSV export

## Deliberately out of scope

- Payment, order and customer mutations of any kind
- A general-purpose catalog editor: a correction is only offered for a product and variant the
  latest scan actually flagged, for the exact issue the change would fix
- Real-time webhook-driven stock alerts, until a captured development-store delivery establishes
  the replay, retry, ordering and duplicate-delivery contract
- Storefront widget


## Adapter/API slice

The UI now reads through `getProductHealthReport()` instead of importing sample data directly.

- `src/lib/ikas/product-adapter.ts`
  - `IkasProductAdapter`
  - `MockIkasProductAdapter`
  - `HttpIkasProductAdapter`
- `src/app/api/report/route.ts` returns JSON report.
- `src/app/api/report.csv/route.ts` returns CSV.

The production report path is live-only and requires a tenant-bound installation session backed by a durable OAuth record. `MockIkasProductAdapter` and sample products remain fixtures; the dashboard and report APIs never fall back to them.
Normal app runtime obtains tokens through OAuth and the server-side `TokenStore`; there is no environment-selected mock adapter path.


## Live ikas validation

Live validation has passed on the development store `dev-emremutlu`.

Working flow:

```bash
npx ikas app dev
```

Then open the app-store launch URL printed by the CLI. The app validates the signed, fresh launch context, runs OAuth when needed, durably stores and verifies the token, and renders a live report from an HttpOnly installation session.

Expected live UI badge:

```text
Data source: live ikas GraphQL
Store: dev-emremutlu
```

Local-development runtime token storage:

```text
.ikas-runtime-tokens.json
```

This file is gitignored and must never be committed.

Production must use a managed Redis-compatible REST store. The preferred current environment names are `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; both are server-only. Missing production storage configuration fails the OAuth install safely and never falls back to this file or to session-only auth.

Production also requires `NEXT_PUBLIC_DEPLOY_URL` to be the exact canonical HTTPS origin, for example `https://health.example.com`. It must not contain a path, query, fragment, userinfo, backslash, or control character. Request `Host` and forwarded-host headers are never used to build OAuth callbacks. Plain HTTP is accepted only for explicit loopback origins outside production.

Daily Pro monitoring is invoked hourly by Vercel at `/api/internal/monitoring/daily`. The scheduler checks at most 50 registered installations per invocation, scans at most 6 eligible installations with concurrency 3, and commits a 23-hour interval after a successful scan independently of optional email delivery. Users therefore receive a new history snapshot approximately once per day, not at a guaranteed local clock time. Missing/disabled email is counted separately and does not cause hourly catalogue rescans. A short owner-checked lease prevents overlap; busy and failed scans are released for a later retry. A durable opaque delivery ID survives retries caused by schedule-completion failure and is sent to Resend as the idempotency key, so an accepted email is not duplicated if schedule completion times out. Production requires server-only `CRON_SECRET` (at least 32 characters), `RESEND_API_KEY`, `IKAS_EMAIL_FROM`, and `IKAS_VERIFIED_EMAIL_RECIPIENTS_JSON`. Recipient records are exact `authorizedAppId + merchantId` matches and must carry `verified: true`; no client-supplied or unverified address is accepted.

OAuth installation success requires durable token persistence, installation-session persistence, and confirmed scheduler registry enrollment. Registry registration is retried idempotently up to three times; after an ambiguous write failure, the callback reconciles by reading the tenant-bound registry record. If enrollment still cannot be confirmed, the callback fails closed and rolls back the token and installation session with compare-and-set safeguards, so an apparently successful installation cannot be silently omitted from scheduled monitoring.

The scheduler is fail-closed by default. Set `IKAS_MONITORING_SCHEDULER_ENABLED=true` only after the production owner has accepted and verified the ikas uninstall/deactivation cleanup contract; without that exact value, authenticated cron requests return `503` before tenant processing. Do not infer or implement an uninstall webhook until ikas documents its signature, exact signed bytes, replay policy, retry behavior, event identifier, and payload schema.

The report page, JSON endpoint, and CSV endpoint derive tenant identity only from the validated HttpOnly installation session. Query-string installation identifiers are not an authorization mechanism and are not included in dashboard, filter, CSV, or mail links.

Production refresh rotation is serialized by a distributed per-installation Redis lease with a monotonic fencing token. The lease winner re-reads the durable record before refresh; waiters re-read after acquisition/waiting, and token replacement, confirmed invalid-grant deletion, and lease release all verify the current lease owner/fence.

The internal tenant-bound uninstall cleanup foundation is implemented but intentionally unwired. Cleanup first writes a durable opaque deletion barrier; production Redis mutation scripts atomically reject later writes for that installation, preventing stale workers from recreating state. The non-expiring barrier is not automatically cleared because reuse of an `authorizedAppId` on reinstall is unverified. Add the webhook route and signature verification only after the exact ikas uninstall event name, payload bytes, secret source, replay policy, retry contract, and reinstall identity semantics are confirmed in the in-repository integration contract.

Known dev-only console noise:

- Next HMR websocket may fail over trycloudflare.
- ikas CDN image may 404 until a Partner app icon is uploaded.

## Current milestone

The safe-operations program is implemented and offline-accepted: unit, browser and real-Redis Lua
acceptance all pass, and every Free/PRO row reports its true rollout state.

The one remaining gate is external: a reversible `dev-emre2` canary on a named product and variant,
with a recorded before value, temporary value and rollback, proving that a single-variant
`updateProduct` preserves every omitted field and every other variant. Until that passes, both
write switches stay off and the correction surface renders an explanation instead of a control.

### Running the real-Redis acceptance

```bash
docker run --rm -d --name ikas-acceptance-redis -p 6399:6379 redis:7-alpine
IKAS_REDIS_ACCEPTANCE=1 ./node_modules/.bin/vitest run src/lib/mutations/redis-acceptance.test.ts
docker rm -f ikas-acceptance-redis
```


## Temporary app icon

A temporary first-letter app icon was generated locally:

- `public/app-icon.svg`
- `public/image_360.webp` (360x360 WebP)

ikas MCP currently does not expose a Partner app asset/upload operation, so the CDN 404 (`cdn.myikas.com/images/<clientId>/null/image_360.webp`) must be fixed by uploading `public/image_360.webp` from the Partner Dashboard app settings. After upload, Emre can replace it with a final branded icon.
