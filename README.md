# ikas Ürün Sağlığı Asistanı

Read-only ikas admin app MVP for validating merchant interest before building a paid Low Stock Alert.

## Current status

- Next.js + TypeScript skeleton created.
- Mock ikas product dataset added.
- Health rules engine implemented and tested.
- Dashboard renders health score, issue counts, issue table, CSV export, and Low Stock Alert CTA placeholder.
- No ikas mutations are used in v1.

## Verified ikas MCP facts

`listProduct` is available with pagination (`limit` max 200, `page`, `hasNext`) and exposes product/variant fields needed for the first report:

- product: `id`, `name`, `brand`, `vendor`, `categories`, `tags`, `description`, `shortDescription`, `metaData`, `totalStock`, `type`, `deleted`, `variants`
- variant: `id`, `sku`, `barcodeList`, `images`, `isActive`, `sellIfOutOfStock`, `prices`, `stocks.stockCount`, `stocks.stockLocationId`, `deleted`

`createMerchantAppPayment` exists, but payment lifecycle is intentionally out of v1 scope.

## Commands

```bash
pnpm test
pnpm test:e2e
pnpm test:all
pnpm lint
pnpm build
pnpm dev
```

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

## Out of scope for v1

- Product/stock mutations
- Bulk fix
- Storefront widget
- Payment activation
- Email alerts
- Low Stock Alert automation
- Product/stock/payment mutations


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

The report page, JSON endpoint, and CSV endpoint derive tenant identity only from the validated HttpOnly installation session. Query-string installation identifiers are not an authorization mechanism and are not included in dashboard, filter, CSV, or mail links.

Production refresh rotation is serialized by a distributed per-installation Redis lease with a monotonic fencing token. The lease winner re-reads the durable record before refresh; waiters re-read after acquisition/waiting, and token replacement, confirmed invalid-grant deletion, and lease release all verify the current lease owner/fence.

Uninstall token cleanup remains a follow-up. Add it only after the exact ikas uninstall event name, payload, and signature-verification contract are confirmed from an in-repository integration contract.

Known dev-only console noise:

- Next HMR websocket may fail over trycloudflare.
- ikas CDN image may 404 until a Partner app icon is uploaded.

## Current milestone

`Ürün Sağlığı Asistanı` now works with live ikas `listProduct` data in read-only mode. Low Stock Alert remains a Phase 2 paid validation hook.


## Temporary app icon

A temporary first-letter app icon was generated locally:

- `public/app-icon.svg`
- `public/image_360.webp` (360x360 WebP)

ikas MCP currently does not expose a Partner app asset/upload operation, so the CDN 404 (`cdn.myikas.com/images/<clientId>/null/image_360.webp`) must be fixed by uploading `public/image_360.webp` from the Partner Dashboard app settings. After upload, Emre can replace it with a final branded icon.
