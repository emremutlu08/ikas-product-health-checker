# Live ikas Gate

This project is ready for mock-mode development. Live ikas integration is blocked until CLI/OAuth login and a test store are available.

## Current local verification

- `pnpm test` passes.
- `pnpm lint` passes.
- `pnpm build` passes.
- `/` renders the report from `MockIkasProductAdapter`.
- `/api/report` returns report JSON.
- `/api/report.csv` returns CSV.

## Live mode env contract

```bash
IKAS_PRODUCT_ADAPTER=http
IKAS_GRAPHQL_ENDPOINT=<real ikas GraphQL endpoint>
IKAS_ADMIN_API_TOKEN=<test store token>
```

Do not commit real tokens. Use local env files only.

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

After OAuth succeeds, the server stores the access token in an encrypted iron-session cookie and `/api/report` uses live `listProduct` through `HttpIkasProductAdapter`.


## Live validation completed — 2026-07-06

Status: **passed** on `dev-emremutlu`.

Observed working flow:

1. `npx ikas app dev`
2. merchant selected: `dev-emremutlu`
3. Cloudflare tunnel created by ikas CLI
4. OAuth callback reached `/api/oauth/callback/ikas`
5. token persisted locally by `authorizedAppId` in `.ikas-runtime-tokens.json` (gitignored)
6. root launch URL with `authorizedAppId` reads live products through `HttpIkasProductAdapter`
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
- `authorized-app/<authorizedAppId>` can show ikas admin shell 404 when opened directly; use the app-store launch link or current tunnel URL instead.

Current rule: live report is read-only. Do not add product, stock, price, or payment mutations to V1.
