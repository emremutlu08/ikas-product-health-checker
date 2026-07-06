# ikas Product Data Health Checker

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
pnpm lint
pnpm build
pnpm dev
```

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

Default mode is mock. Live mode is intentionally gated by env vars:

```bash
IKAS_PRODUCT_ADAPTER=http
IKAS_GRAPHQL_ENDPOINT=<real endpoint>
IKAS_ADMIN_API_TOKEN=<token>
```

Do not enable live mode until a test store/OAuth token is available.


## Live ikas validation

Live validation has passed on the development store `dev-emremutlu`.

Working flow:

```bash
npx ikas app dev
```

Then open the app-store launch URL printed by the CLI. The app receives `storeName` and `authorizedAppId`, runs OAuth when needed, stores the token locally, and renders a live report.

Expected live UI badge:

```text
Data source: live ikas GraphQL
Store: dev-emremutlu
```

Local runtime token storage:

```text
.ikas-runtime-tokens.json
```

This file is gitignored and must never be committed.

Known dev-only console noise:

- Next HMR websocket may fail over trycloudflare.
- ikas CDN image may 404 until a Partner app icon is uploaded.

## Current milestone

`Product Data Health Checker` now works with live ikas `listProduct` data in read-only mode. Low Stock Alert remains a Phase 2 paid validation hook.


## Temporary app icon

A temporary first-letter app icon was generated locally:

- `public/app-icon.svg`
- `public/image_360.webp` (360x360 WebP)

ikas MCP currently does not expose a Partner app asset/upload operation, so the CDN 404 (`cdn.myikas.com/images/<clientId>/null/image_360.webp`) must be fixed by uploading `public/image_360.webp` from the Partner Dashboard app settings. After upload, Emre can replace it with a final branded icon.
