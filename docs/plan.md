# ikas Product Data Health Checker Implementation Plan

> **For Hermes:** This is the approved first-app plan. Implement in small, verified slices before connecting live ikas data.

**Goal:** Build a read-only Product Data Health Checker that scans ikas product data and produces a merchant-facing quality report.

**Architecture:** Start with a deterministic rules engine over the MCP-confirmed `listProduct` shape. Use a mock adapter first, then replace it with a real ikas client after OAuth/test-store access is available. Keep Low Stock Alert as the paid phase-two CTA, not part of the first implementation.

**Tech Stack:** Next.js, TypeScript, Tailwind CSS, Vitest.

---

## Phase 1 — Done in current slice

- Create Next.js app skeleton.
- Add ikas product/variant TypeScript types from MCP introspection.
- Add mock product dataset.
- Add health rules engine.
- Add CSV exporter.
- Add dashboard with score, issue counts, issue table, and CTA.
- Add unit tests for core rules.

## Phase 2 — Next slice

1. Add an `IkasProductAdapter` interface.
2. Add `MockIkasProductAdapter` using the sample data.
3. Add `HttpIkasProductAdapter` skeleton that documents the GraphQL query but requires token/config before runtime use.
4. Add API route `/api/report` returning report JSON from the adapter.
5. Add `/api/report.csv` returning CSV.
6. Keep the UI on mock data until test-store auth is available.

## Phase 3 — Live ikas gate

- Validate ikas app install/OAuth flow.
- Validate `listProduct` with real store data.
- Validate pagination beyond 200 products.
- Observe rate limits.
- Validate `createMerchantAppPayment` lifecycle separately before Low Stock Alert.

## No mutation rule

Do not call `createProduct`, `updateProduct`, `saveVariantStocks`, `updateVariantPrices`, or any order/customer mutation in the first app.


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
