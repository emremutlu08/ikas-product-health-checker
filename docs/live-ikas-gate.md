# Live ikas Gate

The runtime dashboard is hard-gated on a durable ikas OAuth token and uses live `listProduct` data only. Mock product data remains test/development fixture code and is not a report fallback.

## Current local verification

- `pnpm test` passes.
- `pnpm lint` passes.
- `pnpm build` passes.
- `/` shows setup until a signed launch or verified OAuth callback establishes a tenant-bound installation session.
- `/api/report` returns live report JSON only for that HttpOnly session.
- `/api/report.csv` returns a live CSV only for that HttpOnly session.

## Production token-store env contract

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Both values must be configured together as server-only Vercel Production variables. Do not commit or print them. A redeploy is required after linking the Marketplace store.

Set `NEXT_PUBLIC_DEPLOY_URL` to the exact production HTTPS origin. Paths, queries, fragments, userinfo, backslashes, and control characters are rejected. OAuth URL construction never trusts incoming host or forwarded-host headers; non-production HTTP is limited to explicit loopback origins.

## ikas CLI gate

The CLI command is available through `npx ikas`.

Useful commands:

```bash
npx ikas auth login
npx ikas app info
npx ikas app link
npx ikas app dev
```

As of 2026-07-26, Partner CLI authentication is active. `npx ikas app dev` can select `dev-emre2`, establish the development tunnel, and save the merchant app route without another login step.


## OAuth integration added

The app now includes minimal ikas OAuth routes:

- `/authorize-store`
- `/api/oauth/authorize/ikas`
- `/api/oauth/callback/ikas`

After OAuth state validation, token exchange, and app-context validation succeed, the server stores the access/refresh token in the configured `TokenStore` under an internal installation key. Success requires a durable write and read-back. The resulting iron-session cookie contains only tenant identifiers; it never contains OAuth tokens.

Production requires `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. The legacy `KV_REST_API_URL` + `KV_REST_API_TOKEN` pair is accepted only for migrated Vercel KV projects. Production never uses `.ikas-runtime-tokens.json` or memory storage.

Concurrent refreshes are coordinated by a per-installation Redis lease with a monotonic fence. The winner and waiters re-read the durable record, and refresh writes, invalid-grant deletion, and safe release require the current owner/fence so a stale request cannot destroy a newer rotated token.


## Live validation completed — 2026-07-26

Status: **passed** on `dev-emre2`.

Observed runtime evidence:

1. `npx ikas app dev` selected `dev-emre2`, opened a Cloudflare tunnel to local port 3100, and saved the app route.
2. An already-authenticated Chrome Work profile opened the ikas merchant admin at the authorized-app route.
3. The merchant admin displayed `dev-emre2` and `Ürün Sağlığı Asistanı`, and embedded the production app origin with ikas-signed launch parameters. Signed values were inspected only in memory and were not recorded.
4. The app rendered the live dashboard for `dev-emre2` and exposed real catalog product names.
5. `Şimdi tara` completed a fresh read-only scan; the UI reported `Tarama tamamlandı. Rapor bu taramanın sonucunu gösteriyor.`

Fresh scan result shown by the app:

- products scanned: 31
- affected products: 31
- health score: 0/100
- critical issue count: 136
- products in the critical table group: 30
- missing SKU: 30
- out of stock: 6
- missing image, invalid price, duplicate SKU, duplicate title, and description issues: 0
- observed product samples included `Basic Shorts Black`, `Classic Laptop Sleeve 14"`, `Daily Backpack`, and `Grid Tech Organizer - Black`

This is observed signed-launch and live-catalog behavior, not merely unit-test, preview, or schema evidence.

## Earlier live validation — 2026-07-06

Status: **passed** on `dev-emremutlu`.

Observed working flow:

1. `npx ikas app dev`
2. merchant selected: `dev-emremutlu`
3. Cloudflare tunnel created by ikas CLI
4. OAuth callback reached `/api/oauth/callback/ikas`
5. token persisted locally under its internal installation key in `.ikas-runtime-tokens.json` (gitignored development-only validation)
6. the validated HttpOnly installation session reads live products through `HttpIkasProductAdapter`
7. UI shows `Data source: live ikas GraphQL`

Verified live sample:

- store: `dev-emremutlu`
- product count: 1
- active variant count: 1
- score: 85/100
- detected issues: missing SKU, barcode, description, brand, vendor

Known non-blocking dev noise:

- `/_next/webpack-hmr` WebSocket can fail over the Cloudflare tunnel in dev mode.
- `cdn.myikas.com/images/<clientId>/null/image_360.webp` returns 404 until the Partner app has a real uploaded image/logo.

The internal tenant-bound uninstall cleanup foundation now exists, including a durable non-expiring deletion barrier that production Redis mutations check atomically. Webhook wiring remains blocked until this repository contains a confirmed ikas uninstall event, signed-byte/secret contract, replay policy, retry contract, and reinstall identity semantics. No speculative webhook should be deployed.

## Write surface status — 2026-07-26

The read-only V1 rule above described the shipped product before safe corrections existed. It is
superseded for SKU, price and stock corrections, and still holds for everything else — the app
performs no payment, order or customer mutation of any kind.

The correction surface is implemented, offline-accepted and **default-off**:

- `IKAS_PRODUCT_WRITES_ENABLED` gates every single correction and its preview. Unset means closed.
- `IKAS_PRODUCT_BULK_WRITES_ENABLED` additionally gates bulk, and requires the flag above as well.
- With the flags closed, `/corrections` renders an explanation instead of a control, and the plan
  matrix shows the capability as `Geliştirme mağazasıyla sınırlı`.

Neither flag may be opened until a reversible `dev-emre2` canary has proved, with a recorded
before/after/rollback, that a single-variant `updateProduct` leaves every other variant and every
omitted field unchanged.

### Canary status — 2026-07-28

The recorded canary ran on a **single-variant** product, so the sibling-variant case it exists to
prove is still open. Two things block the multi-variant run:

1. The stored `dev-emre2` token has expired and now returns `LOGIN_REQUIRED`. A fresh
   `npx ikas app dev` install is required.
2. Every variant in `dev-emre2` has `sku: null`, and `SkuWriteRequest.sku` is typed `string`, so
   there is no baseline to roll back to. The target variant needs a real SKU set first — set by
   hand in the ikas admin, not by the app, so the canary's own write remains the only one measured.

The write flags stay closed until that run is recorded here.


## Temporary app icon

A temporary first-letter app icon was generated locally:

- `public/app-icon.svg`
- `public/image_360.webp` (360x360 WebP)

ikas MCP currently does not expose a Partner app asset/upload operation, so the CDN 404 (`cdn.myikas.com/images/<clientId>/null/image_360.webp`) must be fixed by uploading `public/image_360.webp` from the Partner Dashboard app settings. After upload, Emre can replace it with a final branded icon.
