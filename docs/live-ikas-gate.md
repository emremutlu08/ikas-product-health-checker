# Live ikas Gate

The runtime dashboard is hard-gated on a durable ikas OAuth token and uses live `listProduct` data only. Mock product data remains test/development fixture code and is not a report fallback.

## Current local verification

- `pnpm test` passes.
- `pnpm lint` passes.
- `pnpm build` passes.
- `/` shows setup until a signed launch or verified OAuth callback establishes a tenant-bound installation session.
- `/api/report` returns live report JSON only for that HttpOnly session.
- `/api/report.csv` returns a live CSV only for that HttpOnly session.

## Production token-store env contract

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Both values must be configured together as server-only Vercel Production variables. Do not commit or print them. A redeploy is required after linking the Marketplace store.

Set `NEXT_PUBLIC_DEPLOY_URL` to the exact production HTTPS origin. Paths, queries, fragments, userinfo, backslashes, and control characters are rejected. OAuth URL construction never trusts incoming host or forwarded-host headers; non-production HTTP is limited to explicit loopback origins.

## ikas CLI gate

The CLI command is available through `npx ikas`.

Useful commands:

```bash
npx ikas auth login
npx ikas app info
npx ikas app link
npx ikas app dev
```

Attempting `npx ikas app info` without an active login opens a Partners OAuth URL and waits for browser login. Hermes stopped there because permission/login must be completed by Emre.

## Next manual step for Emre

1. Run:

```bash
cd /Users/emremutlu/Apps/ikas-apps/ikas-product-health-checker
npx ikas auth login
```

2. Complete the browser login/permission screen.
3. Then run:

```bash
npx ikas app info
```

4. Share the output or tell Hermes to continue.


## OAuth integration added

The app now includes minimal ikas OAuth routes:

- `/authorize-store`
- `/api/oauth/authorize/ikas`
- `/api/oauth/callback/ikas`

After OAuth state validation, token exchange, and app-context validation succeed, the server stores the access/refresh token in the configured `TokenStore` under an internal installation key. Success requires a durable write and read-back. The resulting iron-session cookie contains only tenant identifiers; it never contains OAuth tokens.

Production requires `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. The legacy `KV_REST_API_URL` + `KV_REST_API_TOKEN` pair is accepted only for migrated Vercel KV projects. Production never uses `.ikas-runtime-tokens.json` or memory storage.

Concurrent refreshes are coordinated by a per-installation Redis lease with a monotonic fence. The winner and waiters re-read the durable record, and refresh writes, invalid-grant deletion, and safe release require the current owner/fence so a stale request cannot destroy a newer rotated token.


## Live validation completed — 2026-07-06

Status: **passed** on `dev-emremutlu`.

Observed working flow:

1. `npx ikas app dev`
2. merchant selected: `dev-emremutlu`
3. Cloudflare tunnel created by ikas CLI
4. OAuth callback reached `/api/oauth/callback/ikas`
5. token persisted locally under its internal installation key in `.ikas-runtime-tokens.json` (gitignored development-only validation)
6. the validated HttpOnly installation session reads live products through `HttpIkasProductAdapter`
7. UI shows `Data source: live ikas GraphQL`

Verified live sample:

- store: `dev-emremutlu`
- product count: 1
- active variant count: 1
- score: 85/100
- detected issues: missing SKU, barcode, description, brand, vendor

Known non-blocking dev noise:

- `/_next/webpack-hmr` WebSocket can fail over the Cloudflare tunnel in dev mode.
- `cdn.myikas.com/images/<clientId>/null/image_360.webp` returns 404 until the Partner app has a real uploaded image/logo.

Uninstall cleanup remains a follow-up until this repository contains a confirmed ikas uninstall event and signature contract. No speculative webhook should be deployed.

Current rule: live report is read-only. Do not add product, stock, price, or payment mutations to V1.


## Temporary app icon

A temporary first-letter app icon was generated locally:

- `public/app-icon.svg`
- `public/image_360.webp` (360x360 WebP)

ikas MCP currently does not expose a Partner app asset/upload operation, so the CDN 404 (`cdn.myikas.com/images/<clientId>/null/image_360.webp`) must be fixed by uploading `public/image_360.webp` from the Partner Dashboard app settings. After upload, Emre can replace it with a final branded icon.
