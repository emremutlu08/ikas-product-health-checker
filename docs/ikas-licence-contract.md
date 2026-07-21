# ikas licence contract

What the `getMerchantLicence` GraphQL surface guarantees, and — just as importantly — what it
does not. Source: live schema introspection and a read-only execute over the connected,
authenticated ikas Admin MCP on 2026-07-21.

The development-store execute returned a merchant-scoped response with `appSubscriptions: []`.
No populated app-subscription record was observed, so ACTIVE/cancellation/expiry semantics below
remain schema-derived rather than lifecycle-tested. Treat every "unknown" below as a genuine
gap, not as a detail omitted for brevity.

## Verified from the schema

### Query

| Fact | Value |
| --- | --- |
| Operation | `getMerchantLicence` |
| Arguments | none |
| Return type | `MerchantLicenceResponse!` (non-null) |

The query takes no arguments: ikas scopes the result to the merchant behind the access token.
The caller cannot ask for a specific merchant, and therefore cannot assume the answer is for
the merchant it had in mind — see [Why the caller still checks `merchantId`](#why-the-caller-still-checks-merchantid).

### `MerchantLicenceResponse`

| Field | Type | Nullable |
| --- | --- | --- |
| `merchantId` | `String!` | no |
| `appSubscriptions` | `[MerchantAppSubscription!]` | **the list itself is nullable**; its members are not |

### `MerchantAppSubscription`

| Field | Type | Nullable |
| --- | --- | --- |
| `id` | `String!` | no |
| `authorizedAppId` | `String` | **yes** |
| `storeAppId` | `String!` | no |
| `storeAppListingSubscriptionKey` | `String!` | no |
| `status` | `MerchantSubscriptionStatusEnum!` | no |
| `deleted` | `Boolean!` | no |

### `MerchantSubscriptionStatusEnum`

The enum declares exactly three values:

- `ACTIVE`
- `REMOVED`
- `WILL_BE_REMOVED`

`src/lib/ikas/licence-adapter.ts` validates `status` as a closed enum against this list. A
fourth value is treated as malformed upstream data rather than as a new business state,
because parsing it as a plain string would let a future ikas schema change read as "not
`ACTIVE`" and silently downgrade a paying merchant.

## Not established

These are unknown. The adapter fails closed on each rather than guessing.

- **`appSubscriptions` null semantics.** The list is nullable in the schema. The development
  store smoke returned `[]`, which confirms an empty array is valid for that unsubscribed store,
  but it does not establish what `null` means. The adapter rejects `null` as an unreadable licence
  instead of coercing it to `[]`, because that would turn an unknown state into confirmed Free.
- **`authorizedAppId` vs `storeAppId` matching semantics.** The schema gives both fields but
  does not define which one identifies *this* installation as opposed to the marketplace
  listing. The adapter accepts the expected installation id from the authenticated caller,
  discards foreign rows before strict validation, and returns only exact `authorizedAppId`
  matches. Matching on `storeAppId` would risk resolving one merchant's subscription against
  another merchant's install.
- **Required OAuth scope.** Which scope authorizes this query is not established.
- **Error shape.** The `extensions.code` values ikas returns for authentication versus
  business failures are not established. The adapter treats `UNAUTHENTICATED` and
  `LOGIN_REQUIRED` as authentication failures and everything else as a generic upstream
  GraphQL error.
- **First Pro listing key.** `product-health-pro-try-v1` is a proposed, centralized key only.
  It has not been verified against a saved Partner-panel listing and must not be wired to
  production entitlement until two-person verification is recorded.
- **Per-app trial and expiry data.** No trial window, renewal date, or expiry timestamp is
  known to exist on this type. Nothing in the app may assume one.

## Why the caller still checks `merchantId`

Because the query is argument-free and token-scoped, a response is only meaningful against the
merchant the caller expected. `resolveEntitlement` therefore requires **both** an
`authorizedAppId` and a `merchantId` on its subject, and returns a terminal `denied` state
when the licence's `merchantId` does not match. That state is deliberately distinct from
`unknown`: only `LICENCE_NETWORK_UNAVAILABLE` may one day be softened by a bounded
cache/grace policy. Authentication, GraphQL/schema, and unknown-plan failures remain fail-closed,
and a licence answering for another tenant must never be softened by anything.
