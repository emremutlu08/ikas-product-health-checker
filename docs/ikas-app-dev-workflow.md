# ikas App Dev Workflow — Ürün Sağlığı Asistanı

This is the local workflow we validated while building the first ikas admin app. Keep it in the repo so it can later be exposed through a local MCP server if needed.

## Validated milestone

`Ürün Sağlığı Asistanı` works with live ikas `listProduct` data in read-only mode.

Validated store/app:

- store: `dev-emremutlu`
- app: `ikas-product-health-checker`
- app client id: `ab00348e-4e4f-4ff7-a574-bc485cf7dc53`

## Production token persistence (Vercel)

Root cause of the July 2026 production review failure: the OAuth callback wrote tokens to `process.cwd()/.ikas-runtime-tokens.json`. A Vercel function filesystem is not a durable shared store, so the install ended at `/authorize-store?status=fail&storeName=dev-emre2` after token persistence failed.

Production now requires a managed Redis-compatible REST store. Install/link **Upstash for Redis** from Vercel Marketplace, make its credentials available to the Production environment, and redeploy. The current, preferred environment pair is:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

`KV_REST_API_URL` + `KV_REST_API_TOKEN` remain an atomic compatibility pair for projects migrated from the retired Vercel KV product. Do not mix one key from each pair. The REST token is server-only and must never use a `NEXT_PUBLIC_` prefix.

Configure the production application origin separately:

```text
NEXT_PUBLIC_DEPLOY_URL=https://health.example.com
```

This value must be an exact HTTPS origin: no path, query, fragment, userinfo, backslash, or control character. OAuth callbacks and app redirects use only this configured origin and never trust request `Host`, `X-Forwarded-Host`, or `X-Forwarded-Proto`. Outside production, plain HTTP is allowed only for explicit `localhost`, `127.0.0.1`, or `[::1]` origins.

Tokens are stored under an internal per-installation key that is never accepted from a report URL. A callback is successful only after the record is written and read back with matching contents. Missing/partial production configuration, a backend error, or a read-back mismatch fails with an allowlisted reason and support ID; it never falls back to the filesystem or a browser token.

Refresh rotation uses an atomic Redis lease per installation plus a monotonically increasing fencing token. The winner re-reads the durable token after acquiring the lease. Waiters poll briefly and re-read rather than reusing a stale refresh token. Replacement and confirmed invalid-grant deletion require both the active lease fence and the exact record originally read; release deletes only the same owner/fence value. A loser request therefore cannot overwrite or delete a newer callback/refresh record.

For explicit non-production use only:

```text
IKAS_TOKEN_STORE_DRIVER=file    # NODE_ENV=development
IKAS_TOKEN_STORE_DRIVER=memory  # NODE_ENV=test/development
```

`file` and `memory` are rejected when `NODE_ENV=production`. Development defaults to the gitignored file when no REST pair is configured; tests default to memory.

## Read-only rule

V1 must not call product, stock, price, payment, customer, order, or webhook mutations.

Allowed live operations for the Health Checker path:

- OAuth/token exchange through ikas app flow
- `getMerchant`
- `getAuthorizedApp`
- `listProduct`

## First-time setup

```bash
cd /Users/emremutlu/Apps/ikas-apps/ikas-product-health-checker
npx ikas auth login
npx ikas app info
```

The local app config files are credential-bearing and must stay uncommitted:

- `.env`
- `.ikas/config.json`
- `.ikas-runtime-tokens.json`

## Dev tunnel flow

```bash
npx ikas app dev
```

Expected flow:

1. Select `dev-emremutlu` merchant.
2. Let CLI run the app if port 3000 is not reachable.
3. CLI creates a Cloudflare tunnel.
4. Open the app-store launch URL printed by the CLI.
5. ikas redirects to the tunnel URL with fresh, signed merchant and installation launch context.
6. If the durable token is missing, the validated launch handler redirects directly to `/api/oauth/authorize/ikas?storeName=...`.
7. OAuth callback stores and reads back the tenant-bound token (managed REST storage in production, gitignored file in local development).
8. Root page uses the validated HttpOnly installation session to call live `listProduct` through `HttpIkasProductAdapter`.

Expected UI badge:

```text
Data source: live ikas GraphQL
Store: dev-emremutlu
```

## Live verification

Open the app through the signed app-store launch URL. After the launch or OAuth callback establishes the HttpOnly installation session, verify the dashboard and use its `/api/report` and `/api/report.csv` links in the same browser session. Do not construct report URLs with installation identifiers.

Expected live sample during validation:

- source: `http`
- score: `85`
- product count: `1`
- issue count: `5`
- product: `Elma`

## Known non-blocking dev warnings

- Next HMR websocket can fail through trycloudflare.
- ikas CDN image 404 is fixed by uploading an app icon in Partner Dashboard. Temporary icon lives at `public/image_360.webp`.

## Uninstall cleanup follow-up

Do not add an uninstall webhook speculatively. Confirm the exact ikas uninstall event, payload, and signature contract in this repository first; then add durable token/session cleanup with signature and replay tests.

## When to turn this into MCP

Do not add another MCP server until the workflow repeats at least once for a second ikas app. If needed later, expose a small local MCP with tools like:

- `get_ikas_app_workflow`
- `get_ikas_live_gate_checklist`
- `get_product_health_checker_status`
- `next_revenue_step`
