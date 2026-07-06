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
- Real OAuth/install flow until test-store credentials are available


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
