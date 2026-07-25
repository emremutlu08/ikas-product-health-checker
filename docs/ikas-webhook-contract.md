# ikas webhook contract

Status: **BLOCKED — documentation only.**

This file records what the official ikas documentation states about app webhooks, and
separates it from what is still unverified. No webhook route may be implemented until
every item in the [Open questions](#open-questions--blockers) section has a written
first-party answer.

The internal, store-agnostic tenant cleanup foundation now exists. It is intentionally
unwired: no webhook/API route or signature module calls it.

## Verified first-party facts

These come directly from the supplied official ikas documentation.

### Scopes

| Purpose | Scope |
|---|---|
| Plan purchase / payment | `store/app/payment` |
| App deletion (uninstall) | `store/app/deleted` |

### Payload fields

The webhook payload contains:

- `signature`
- `authorizedAppId`
- `merchantId`
- `id`
- `createdAt`

### Payment processing rule

Only events with a `PAID` status are to be processed. Any other status must not be
treated as a completed purchase.

### Licence source of truth

`getMerchantLicence` is the current source for a store's app licence. The webhook is a
notification, not an authorization record.

### Testing

Plan purchase can be tested on development stores.

## Open questions — blockers

Each of the following is **UNKNOWN** and must be confirmed in writing by ikas before any
signature verification or webhook handler is written.

1. **UNKNOWN / BLOCKER — signature algorithm and canonicalization.** The exact algorithm
   used to produce `signature`, and the exact byte sequence it is computed over, are not
   documented in the supplied material. The presence of a `signature` field is not
   itself a verification scheme.
2. **UNKNOWN / BLOCKER — secret source.** Which secret is used to compute and verify the
   signature, and where it is obtained from, is not documented.
3. **UNKNOWN / BLOCKER — replay window.** Whether a timestamp/replay tolerance exists,
   and what window is expected, is not documented. `createdAt` is present in the payload
   but its role in replay protection is unconfirmed.
4. **UNKNOWN / BLOCKER — retry policy.** Delivery retry behaviour, retry counts, backoff,
   and the idempotency guarantees expected of the receiver are not documented.
5. **UNKNOWN / BLOCKER — deletion payload canonicalization.** For `store/app/deleted`,
   whether the `data` field being a JSON string (rather than a JSON object) changes the
   canonicalization used for signature computation is not documented. This directly
   affects whether one verification routine can serve both scopes.

## Consequences for implementation

- Do not add `src/app/api/webhooks/ikas/route.ts` or any signature verification module
  while the items above are UNKNOWN.
- Do not treat a `store/app/payment` event as granting entitlement. Entitlement must be
  resolved server-side from `getMerchantLicence`.
- Do not count the existence of the `signature` field as verification.

## Uninstall cleanup foundation

`src/lib/lifecycle/tenant-cleanup-service.ts` accepts only the validated canonical tenant
identity (`authorizedAppId` and `merchantId`). A future authenticated caller can invoke
the service after the first-party signature, canonical-byte, secret-source, replay, and
retry contracts are known.

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
