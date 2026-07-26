# ikas product mutation and stock-event contract

Status: **PARTIALLY VERIFIED — preview-only implementation may proceed; production writes remain gated.**

Verified on 2026-07-26 against the official ikas Admin MCP endpoint. No mutation was executed while collecting this schema evidence.

## Verified GraphQL operations

### `updateProduct`

```graphql
mutation updateProduct($input: UpdateProductInput!) {
  updateProduct(input: $input) { id updatedAt }
}
```

`UpdateProductInput` requires `id`. Optional fields include product name, description, brand, vendor, categories, tags, metadata, sales channels, translations, type, weight, and variants.

Each `UpdateProductVariantInput` requires a variant `id`; optional fields include `sku`, `barcodeList`, images, active state, prices, `sellIfOutOfStock`, unit, and weight.

The first-party `Update Product` example sends only product `id` and `description`, proving
product-level omitted fields are intended to be preserved:

- https://builders.ikas.com/docs/admin-api/admin-apis/product/update-product

The first-party SDK identifies `write_products` as the product write permission. On 2026-07-26,
the Partner app was updated to `READ_PRODUCTS`, `READ_INVENTORIES`, `WRITE_PRODUCTS`, and
`WRITE_INVENTORIES`; `dev-emre2` completed OAuth re-consent, and a tenant-token Admin API
read-back returned `read_products,read_inventories,write_products,write_inventories`. The
production OAuth route now requests that same exact set. This grants capability only: no product,
price, or inventory mutation was executed during permission acceptance.

**Not yet verified:** whether an input containing one variant is a safe partial update that leaves every omitted variant and omitted variant field unchanged. This must be proved on `dev-emre2` with a reversible test before production wiring.

### `saveVariantStocks`

```graphql
mutation saveVariantStocks($input: SaveVariantStocksInput!) {
  saveVariantStocks(input: $input) {
    errors { errorCode inputArrayIndex inputData { productId variantId } }
  }
}
```

Each stock input contains:

- `productId: String!`
- `variantId: String!`
- `stockLocationId: String!`
- `stockCount: Float!`
- optional `deleted: Boolean`

The response is item-oriented and can return an error code plus the failing array index. The schema describes `stockCount` as the quantity to save, not a delta.

The first-party SDK identifies `write_inventories` as the inventory write permission.

**Not yet verified:** request-size limit, concurrency semantics, stale-write support, idempotency, retry behaviour, and whether a successful response can contain a partial failure list.

### `updateVariantPrices`

```graphql
mutation updateVariantPrices($input: UpdateVariantPricesInput!) {
  updateVariantPrices(input: $input) {
    errors { errorCode inputArrayIndex }
  }
}
```

The input accepts an optional `priceListId` and at most **3000** variant entries. Each entry contains:

- `productId: String!`
- `variantId: String!`
- optional `deleted: Boolean`
- `price.sellPrice: Float!`
- optional `price.buyPrice`
- optional `price.discountPrice`

The official schema explicitly states that the price objects supplied to this operation are **overridden**. Callers must therefore re-read the exact current price object, require explicit merchant confirmation, and submit every value that must survive the update.

**Not yet verified:** currency/price-list defaults, decimal rules, partial failures, idempotency, and concurrent price-edit behaviour.

## Verified stock webhook registration scopes

`saveWebhooks(input: WebhookInput!)` accepts an HTTPS endpoint and scopes. The official schema lists these stock scopes:

- `store/stock/created`
- `store/stock/updated`

It also lists product-created/updated, order-created/updated, customer-created/updated, and customer-favourite scopes.

This proves that event-driven stock monitoring is available in the public API. It does **not** prove the receiver security contract.

The first-party webhook guide requires applications to use `@ikas/admin-api-client`:

- `validateIkasWebhookSignature(webhookData, CLIENT_SECRET)`
- `getParsedIkasWebhookData(webhookData, CLIENT_SECRET)`

The installed first-party SDK (`2.1.0`) exports both functions and defines the envelope as
`id`, `createdAt`, `scope`, `merchantId`, string `data`, `signature`, and `authorizedAppId`.
Its `IWebhookStock` payload extends `ProductStockLocation`, whose verified fields are:

- `id`
- `productId`
- `variantId`
- `stockLocationId`
- `stockCount`
- `deleted`
- optional `createdAt`
- optional `updatedAt`

The verification secret is the app `CLIENT_SECRET`. The underlying algorithm and canonical-byte
rules are intentionally treated as SDK internals; this project must not reimplement them.

First-party references:

- https://builders.ikas.com/docs/admin-api/admin-apis/webhook/save-webhook
- https://builders.ikas.com/docs/app-development/ikas-sdk/webhooks

## Unknown / production blockers

The following remain unverified for stock events and require defensive handling plus development-store delivery acceptance before public enablement:

1. replay/timestamp rules;
2. retry, ordering, timeout, and duplicate-delivery behaviour;
3. registration replacement/merge semantics for repeated `saveWebhooks` calls;
4. required webhook-registration permission and re-authorization behaviour.

Inventory permissions are documented separately: `read_inventories` reads stock locations and
levels, while `write_inventories` manages them. Whether registration itself requires either scope
is not stated by the located first-party material.

## Verified Admin API rate limits

The first-party rate-limit page documents:

- at most **50 requests per 10 seconds**;
- `429 Too Many Requests` when that limit is exceeded;
- an automatic one-hour block when the last hour's error rate exceeds 25%;
- at least 60% errors plus more than 300 requests in one hour: 30-minute block;
- at least 60% errors plus more than 3000 requests in one day: 12-hour block;
- at least 60% errors plus more than 9000 requests in five days: permanent block;
- separate webhook-delivery blocking thresholds when receiver errors reach at least 70%.

Source: the current ikas Builders **Rate Limits ve Engelleme Kuralları** page linked from the
Admin API documentation.

The SKU MVP therefore sends at most one mutation per explicit confirmation. Later bulk work must
use a shared limiter below the documented ceiling, honor `429` without immediate retry, classify
validation failures as terminal, and stop a batch when error-rate protection is at risk.

The Admin MCP token is not a merchant installation token: a read-only `getAuthorizedApp` execution returned `null`. This is not evidence that the installed `dev-emre2` app lacks scope. The effective scope must be read using the tenant-bound installation token or observed in the Partner/merchant authorization UI.

## Required write architecture

Before any production mutation route is enabled:

1. derive tenant only from the sealed installation session;
2. require a live, tenant-bound entitlement and an explicit write feature grant;
3. create a preview from a stored issue and bind it to exact product/variant identifiers;
4. re-read the live product immediately before confirmation;
5. compare the current `updatedAt` and old field value with the preview expectation;
6. require an explicit, one-time merchant confirmation;
7. reject replay and duplicate execution with a durable idempotency record;
8. check the tenant deletion barrier in the same durable decision path;
9. execute only an allowlisted mutation field;
10. re-read ikas after success and verify the exact intended value;
11. store a tenant-bound audit result without tokens or full product payloads;
12. report partial failures per item and never retry a non-idempotent write blindly.

## First implementation slice

The first slice is SKU correction preview only. It performs no GraphQL mutation. A preview is valid only when:

- the latest stored report contains an exact `missing_sku` issue for the product and variant;
- the proposed SKU is explicit and passes local safety validation;
- the issue carries a valid product `updatedAt` stale-write guard;
- the preview states that live verification is still required.

A reversible `dev-emre2` mutation test requires explicit approval before execution.
