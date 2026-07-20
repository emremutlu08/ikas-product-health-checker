# ikas webhook contract

Status: **BLOCKED — documentation only.**

This file records what the official ikas documentation states about app webhooks, and
separates it from what is still unverified. No webhook route may be implemented until
every item in the [Open questions](#open-questions--blockers) section has a written
first-party answer.

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
