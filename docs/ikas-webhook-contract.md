# ikas webhook contract

Status: **SDK VERIFICATION BOUNDARY CONFIRMED; live delivery acceptance remains open. Low-stock alerting ships without webhooks.**

This file records what the official ikas documentation and installed first-party SDK state
about app webhooks, and separates that evidence from delivery behaviour that is still
unverified. A route must use the SDK verification/parsing functions; it must never implement
the undisclosed signature algorithm or canonicalization itself.

The internal, store-agnostic tenant cleanup foundation now exists. It is intentionally
unwired: no webhook/API route or signature module calls it.

## Low-stock alerting is polling, and says so

The shipped low-stock crossing and recovery notifications are derived from the scheduled scan, not
from `store/stock/created` or `store/stock/updated` deliveries. No webhook route exists in this
application, no signature is validated, and nothing here is presented to a merchant as real-time.

That is a deliberate consequence of the open questions below: without a captured development-store
delivery there is no evidence about replay windows, retry behaviour, ordering or duplicate
delivery, and a receiver built on guesses about those would either miss events or act on them
twice. Polling from a scan the app already performs has none of those unknowns.

If webhooks are added later they must use only `validateIkasWebhookSignature` and
`getParsedIkasWebhookData`, and the alert state machine already in
`src/lib/alerts/low-stock-alerts.ts` is the natural consumer: it is keyed by tenant, product,
variant and stock location and is idempotent per scan, so an event-driven source would replace the
observation input without changing the notification rules.

## Verified first-party facts

These come directly from the supplied official ikas documentation.

### Scopes

| Purpose | Scope |
|---|---|
| Plan purchase / payment | `store/app/payment` |
| App deletion (uninstall) | `store/app/deleted` |
| Stock record created | `store/stock/created` |
| Stock record updated | `store/stock/updated` |

### Official verification boundary

The current first-party guide documents:

- `validateIkasWebhookSignature(webhookData, CLIENT_SECRET)`
- `getParsedIkasWebhookData(webhookData, CLIENT_SECRET)`

The secret source is the app `CLIENT_SECRET`. The installed `@ikas/admin-api-client` `2.1.0`
package exports both functions. The cryptographic algorithm and canonical bytes remain SDK
internals and must not be copied or guessed in this application.

Sources:

- https://builders.ikas.com/docs/app-development/ikas-sdk/webhooks
- https://builders.ikas.com/docs/admin-api/admin-apis/webhook/save-webhook

### Payload fields

The webhook payload contains:

- `signature`
- `authorizedAppId`
- `merchantId`
- `id`
- `createdAt`
- `scope`

The SDK models `data` as a JSON string. `getParsedIkasWebhookData` is the required parser after
signature validation.

For stock scopes, the SDK's `IWebhookStock` extends `ProductStockLocation` with `id`, `productId`,
`variantId`, `stockLocationId`, `stockCount`, `deleted`, and optional `createdAt`/`updatedAt`.

### Payment processing rule

Only events with a `PAID` status are to be processed. Any other status must not be
treated as a completed purchase.

### Licence source of truth

`getMerchantLicence` is the current source for a store's app licence. The webhook is a
notification, not an authorization record.

### Testing

Plan purchase can be tested on development stores.

## Open questions — blockers

The application must handle the following as unknown delivery behaviour and prove the route
with a captured development-store delivery before production enablement.

1. **UNKNOWN — replay window.** Whether a timestamp/replay tolerance exists,
   and what window is expected, is not documented. `createdAt` is present in the payload
   but its role in replay protection is unconfirmed.
2. **UNKNOWN — retry policy.** Delivery retry behaviour, retry counts, backoff,
   and the idempotency guarantees expected of the receiver are not documented.
3. **UNKNOWN — ordering and duplication.** No ordering guarantee, event-retention contract,
   or duplicate-delivery window has been located.
4. **UNKNOWN — registration replacement semantics.** Whether repeated `saveWebhooks` calls
   merge or replace existing registrations requires a development-store test.

## Consequences for implementation

- Use only `validateIkasWebhookSignature` and `getParsedIkasWebhookData` from the first-party SDK.
- Never build a custom HMAC/hash/canonicalization implementation.
- Parse the SDK output through a strict scope-specific schema before any side effect.
- Treat `id` as the candidate idempotency key and persist it before applying an event; verify its
  stability with captured duplicate/retry deliveries.
- Return success only after the idempotency record and resulting state transition are durable.
- Do not treat a `store/app/payment` event as granting entitlement. Entitlement must be
  resolved server-side from `getMerchantLicence`.
- Do not count the existence of the `signature` field as verification; require SDK validation.

## Uninstall cleanup foundation

`src/lib/lifecycle/tenant-cleanup-service.ts` accepts only the validated canonical tenant
identity (`authorizedAppId` and `merchantId`). A future SDK-authenticated caller can invoke
the service after strict payload validation and durable event idempotency. Replay/retry behaviour
must still be exercised in development-store acceptance.

Cleanup is deterministic and best-effort in this order:

1. durable, opaque deletion barrier
2. installation registry
3. token and refresh lease (the refresh fencing counter is retained)
4. monitoring schedule state
5. latest/history snapshots and scan lease
6. monitoring settings
7. paid-feature interest records

The deletion barrier is written before any component cleanup. The write is an atomic
compare-or-set: an existing marker is idempotent only when its opaque installation-and-merchant
digest matches; a different merchant digest fails with `identity_mismatch` before any component
is deleted. If that durable write fails, cleanup stops without deleting component state. Production
Redis mutation scripts for registry, token/refresh lease, monitoring schedule, snapshots/scan lease,
settings, and interest records check the same opaque barrier key inside the mutation's Lua
transaction, so a stale worker cannot recreate tenant state after cleanup begins. The marker has no
expiry and is never automatically cleared: reuse of an `authorizedAppId` on reinstall is unverified,
so reopening it would not be fail-closed.

Every store operation uses exact tenant-derived keys; none uses `SCAN`, a wildcard, or a
new settings-key format. The service continues after component failures and returns only
component names, sanitized status/error codes, and overall completeness. Retrying the
whole cleanup is idempotent.

Interest records are deleted rather than silently retained because they contain tenant
identifiers, an operational feature-interest signal, and a timestamp. Their finite
allowlisted intent keys make exact tenant-verified deletion possible without scanning.

Verified recipients are runtime environment configuration, not tenant records. They are
therefore explicitly outside uninstall cleanup and cannot be runtime-deleted.
