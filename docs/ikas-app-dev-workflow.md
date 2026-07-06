# ikas App Dev Workflow — Ürün Sağlığı Asistanı

This is the local workflow we validated while building the first ikas admin app. Keep it in the repo so it can later be exposed through a local MCP server if needed.

## Validated milestone

`Ürün Sağlığı Asistanı` works with live ikas `listProduct` data in read-only mode.

Validated store/app:

- store: `dev-emremutlu`
- app: `ikas-product-health-checker`
- app client id: `ab00348e-4e4f-4ff7-a574-bc485cf7dc53`
- authorized app id used in test: `49328cc1-91f5-4f2e-a5db-43d7f7f1fbde`

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
5. ikas redirects to the tunnel URL with `storeName`, `merchantId`, `signature`, and `authorizedAppId`.
6. If token is missing, root page redirects to `/api/oauth/authorize/ikas?storeName=...`.
7. OAuth callback stores the token keyed by `authorizedAppId` in `.ikas-runtime-tokens.json`.
8. Root page uses `authorizedAppId` to call live `listProduct` through `HttpIkasProductAdapter`.

Expected UI badge:

```text
Data source: live ikas GraphQL
Store: dev-emremutlu
```

## Live verification commands

Replace the authorized app id if ikas generates a new installation.

```bash
AID=49328cc1-91f5-4f2e-a5db-43d7f7f1fbde
curl "http://localhost:3000/api/report?authorizedAppId=$AID"
curl "http://localhost:3000/api/report.csv?authorizedAppId=$AID"
```

Expected live sample during validation:

- source: `http`
- score: `85`
- product count: `1`
- issue count: `5`
- product: `Elma`

## Known non-blocking dev warnings

- Next HMR websocket can fail through trycloudflare.
- `authorized-app/<id>` can show ikas admin shell 404 when opened directly. Use the app-store launch URL or tunnel URL.
- ikas CDN image 404 is fixed by uploading an app icon in Partner Dashboard. Temporary icon lives at `public/image_360.webp`.

## When to turn this into MCP

Do not add another MCP server until the workflow repeats at least once for a second ikas app. If needed later, expose a small local MCP with tools like:

- `get_ikas_app_workflow`
- `get_ikas_live_gate_checklist`
- `get_product_health_checker_status`
- `next_revenue_step`
