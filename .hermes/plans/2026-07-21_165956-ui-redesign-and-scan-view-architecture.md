# Product Health Checker UI Redesign and Scan/View Architecture Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Keep one active PR slice at a time and use strict RED → GREEN → REFACTOR.

**Goal:** Turn the current prototype-like interface into a trustworthy, coherent ikas embedded admin product while eliminating the full-catalog re-scan caused by every dashboard navigation and laying the correct foundation for scan history, diff, and Pro.

**Architecture:** Split scanning from viewing. A scan is an explicit, tenant-bound operation that produces an immutable minimal snapshot; dashboard navigation, filters, CSV, history, and diff read snapshots without calling ikas again. In parallel, unify setup/OAuth/dashboard under a neutral-led design system with one interaction accent and status-only red/amber/green.

**Tech Stack:** Next.js 16.2.10 App Router, React, TypeScript, Tailwind CSS, Vitest, Playwright, Upstash Redis REST, ikas Admin GraphQL.

**Evidence:** Hermes production visual inspection + source audit; independent Claude Opus high-effort review; adversarial correction pass in the same Claude session (`2b43f775-0c5c-4044-a7c6-06228f572dd2`).

---

## 1. Evidence synthesis

### Directly observed in production

- Setup screen has two differently labeled CTAs that both navigate to `/authorize-store`.
- Setup uses a light neutral surface; authorize-store switches to a full-bleed dark/neon surface.
- OAuth form does not repeat the true read-only permission promise at the point of authorization.
- Production setup and authorization pages load without console errors.

### Source-verified defects

1. `src/app/page.tsx` uses merchant-facing prototype language: `ilk sürüm`, `Ücretli MVP sinyali`.
2. `src/app/layout.tsx` exposes `MVP` in production metadata.
3. `src/app/page.tsx` is `force-dynamic` and runs `getProductHealthReport` on every render.
4. Every URL-driven rule-filter click renders the page again, causing another complete paginated ikas catalog scan.
5. A scan may run up to 50 pages / 10,000 products / 45 seconds, yet no `loading.tsx` exists.
6. Non-auth failures are re-thrown and there is no branded Turkish `error.tsx`; scan-limit and upstream failures fall through to Next's generic error UI.
7. No custom `not-found.tsx` exists; framework fallback is English.
8. Table wrapper uses `overflow-hidden` around a `min-w-[860px]` table, clipping row actions on narrow embedded widths.
9. Health score subtracts issue-instance penalties without catalog-size normalization. Frequency in real stores is unknown, but catalog size structurally affects the result.
10. Zero products currently imply zero penalty and therefore `100/100`, which is not a meaningful health result.
11. Active rule state is encoded largely through color; the filter group lacks navigation semantics and accessible count labels.
12. Error messages produce a support UUID but provide no copy control or explicit support channel.

### Shared conclusions: Hermes + Claude

- Use one coherent visual system throughout onboarding and dashboard.
- Remove internal/prototype terminology.
- Put trust and permission information at the OAuth decision point.
- Collapse duplicate setup actions.
- Replace decorative color proliferation with neutral surfaces, one interaction accent, and status-only colors.
- Improve dashboard information hierarchy, table usability, accessibility, loading, error, and empty states.
- Preserve Turkish-only V1, URL-driven filter state, read-only behavior, tenant-bound server-side identity, and the honest low-stock disclaimer.

### Claude findings that changed the plan

- The highest-impact issue is architectural, not cosmetic: rule navigation re-scans the entire catalog.
- Snapshot/history work and scan/view separation should be the same phase, not independent fixes.
- Score normalization requires representative fixtures; no unsupported claim about real-world score frequency should be made.
- The earlier viewport-export criticism was retracted after checking installed Next.js documentation and production output.
- `aria-pressed` is incorrect for URL-navigation links; use a labelled `<nav>` and `aria-current="page"` for the active link.

### Hermes findings retained in the synthesis

- Dashboard lacks a clear primary operation such as `Şimdi tara` and a legible freshness model.
- KPI cards consume too much space and do not communicate priority or trend.
- Seven competing hues weaken hierarchy; emoji/glyph icons undermine product polish.
- The upsell block dominates the page while admitting the feature is unfinished.
- The operational table needs search, sort, severity, active-filter summary, and pagination/controlled rendering.

---

## 2. Product principles

1. **Trust before conversion:** authorization copy must say what is read, what is not changed, what is stored, and what happens next.
2. **Scan is an operation; view is a read:** navigation must never trigger a full ikas catalog scan.
3. **Freshness is explicit:** every report shows when it was produced and offers a deliberate re-scan action.
4. **One accent, status colors only:** neutral surfaces; one interaction accent; red/amber/green only for severity and outcomes.
5. **No prototype language:** no `MVP`, `ilk sürüm`, `sinyal`, fake ratings, or internal experiment terminology.
6. **Free remains useful:** manual scan, filters, and CSV stay available without Pro.
7. **Pro sells continuity:** history, diff, scheduled monitoring, low-stock thresholds, and verified summaries—not a generic email promise.
8. **Embedded-first:** verify at narrow iframe widths before desktop polish.
9. **Evidence classes remain separate:** mocked dashboard acceptance is not signed ikas launch acceptance.

---

## 3. Target information architecture

### Setup / authorization

- Product identity: `Ürün Sağlığı`
- One-sentence value proposition
- Three concise benefits
- Read-only trust statement
- One primary action
- Store-name form only when automatic launch context is unavailable
- OAuth error block with copyable support code and reachable support channel

### Dashboard header

- Product name
- Merchant/store name
- Free/Pro state
- `Son tarama: …`
- Primary action: `Şimdi tara`
- Secondary navigation: `Geçmiş`, `Ayarlar`, `Plan`

### Dashboard body

1. Health summary and change since prior snapshot
2. Critical actions requiring attention
3. New / ongoing / resolved issues
4. Rule filters with counts and severity
5. Searchable, sortable, accessible product table
6. Restrained Pro surface for locked history/schedule/email features

---

## 4. Delivery strategy

Use separate PRs. Do not combine visual cleanup, scan persistence, score-model changes, and Pro gating into one review surface.

### PR A — Runtime safety and onboarding coherence

**Objective:** Ensure no setup/error path looks broken or untrustworthy before changing dashboard architecture.

**Files:**
- Create: `src/app/loading.tsx`
- Create: `src/app/error.tsx`
- Create: `src/app/not-found.tsx`
- Create tests beside the relevant app boundaries using existing project conventions
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.test.tsx`
- Modify: `src/app/authorize-store/page.tsx`
- Modify: `src/components/AuthorizeStoreForm.tsx`
- Modify/create: `src/components/AuthorizeStoreForm.test.tsx`
- Modify: `src/lib/ikas/oauth-failure.ts` only if support copy requires it

#### Task A1 — Error boundaries

1. RED: test Turkish UI for generic upstream failure, scan-budget failure, and not-found state.
2. Verify tests fail because boundaries do not exist.
3. GREEN: add branded neutral-surface boundaries with retry/back-to-dashboard controls.
4. Preserve sanitized support/error identifiers; never render raw upstream messages.
5. Verify focused tests and accessibility names.

**Acceptance:**
- No application route renders an English or unstyled framework page inside ikas.
- `IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED` gets a distinct, truthful Turkish explanation.
- Retry is explicit and does not claim partial data.

#### Task A2 — Loading state

1. RED: test the loading boundary's core status and accessible live-region text.
2. GREEN: add a skeleton/status surface matching the final dashboard shell.
3. Manually verify under a throttled response.

**Acceptance:**
- A slow scan never presents a blank iframe.
- Loading copy does not promise a percentage the backend cannot measure.

#### Task A3 — Unified onboarding

1. RED: assert rendered output contains one primary setup CTA, no duplicate destination, no `MVP`/`ilk sürüm`/`sinyal` copy.
2. RED: assert authorize form includes read-only disclosure before submit.
3. GREEN: use the same light neutral surface, card, radius, typography, and primary button token across both pages.
4. Remove fake/decorative rating stars.
5. Keep store-name normalization; accept a full ikas admin URL as forgiving input where existing normalization already supports it.
6. Change `autoComplete="organization"` to an appropriate non-misleading value.

**Acceptance:**
- One primary setup action.
- Authorization explains requested read scopes, no product/stock writes, minimum stored installation data, and next step.
- No unverified privacy or retention promise is introduced.
- No full-bleed dark OAuth interstitial.

#### Task A4 — Form accessibility and support recovery

1. RED: keyboard focus, error association, invalid state, and copy-support-code behavior.
2. GREEN: add `focus-visible` ring, `aria-describedby`, `aria-invalid`, and a copy control.
3. Add a support channel only after confirming the actual address/route; do not invent one.

**Acceptance:**
- Keyboard users can see focus.
- Failed OAuth focuses or announces the error.
- Support code can be copied without exposing internal stack details.

#### PR A validation

```bash
pnpm vitest run src/app/page.test.tsx src/components/AuthorizeStoreForm.test.tsx
pnpm test
pnpm test:e2e
pnpm lint
pnpm build
git diff --check
```

Manual widths: 360, 768, 1280 pixels. Verify production-like setup, authorize, loading, scan-limit error, generic error, and 404.

---

### PR B — Snapshot store and scan/view separation

**Objective:** Make one explicit scan produce a tenant-bound immutable snapshot; make dashboard filters and CSV read that snapshot without calling ikas.

**Files:**
- Create: `src/lib/scans/snapshot-store.ts`
- Create: `src/lib/scans/snapshot-store.test.ts`
- Create: `src/lib/scans/scan-service.ts`
- Create: `src/lib/scans/scan-service.test.ts`
- Create: `src/app/api/scans/route.ts`
- Create: `src/app/api/scans/route.test.ts`
- Modify: `src/lib/ikas/report-service.ts`
- Modify: `src/lib/ikas/report-service.test.ts`
- Modify: `src/app/api/report/route.ts`
- Modify: `src/app/api/report.csv/route.ts`
- Modify: `src/app/api/report/route.test.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.test.tsx`

#### Task B1 — Snapshot schema and tenant partitioning

1. RED: define minimum snapshot behavior for `authorizedAppId`, `merchantId`, generated timestamp, aggregate counts, and stable issue rows.
2. RED: prove one tenant cannot read another tenant's snapshot.
3. RED: reject malformed stored data fail-closed.
4. GREEN: implement Redis-backed storage using the project's existing dependency-injection pattern.
5. Store no token and no unnecessary full GraphQL product payload.

**Retention decision:**
- Free: latest successful snapshot only.
- Pro: bounded history, configured count and age.
- Do not enforce Pro history until entitlement wiring is connected; keep the storage policy injectable and default-deny for history reads.

#### Task B2 — Explicit scan operation

1. RED: authenticated manual scan invokes `listProducts` exactly once and persists one snapshot.
2. RED: missing session, wrong Origin, and client-supplied tenant identifiers produce no scan.
3. RED: scan-limit and upstream errors never overwrite the prior successful snapshot.
4. GREEN: implement `POST /api/scans` with tenant identity from the server session.
5. Add per-installation lease/idempotency to prevent concurrent duplicate scans.

**Acceptance:**
- Manual scan remains Free.
- No client query/header/cookie can select another installation.
- Failed scans leave the last successful snapshot readable and visibly stale.

#### Task B3 — Read path

1. RED: dashboard render with an existing snapshot makes zero ikas product API calls.
2. RED: changing `?rule=` makes zero ikas product API calls.
3. RED: JSON and CSV derive from the same snapshot.
4. GREEN: page and report routes read the latest snapshot.
5. If no snapshot exists, show a first-scan state with an explicit scan action; do not silently scan on every page render.

**Acceptance:**
- Filter clicks and `Filtreyi temizle` trigger zero upstream catalog calls.
- `Son tarama` displays the snapshot timestamp and freshness.
- CSV does not trigger a second scan.

#### PR B validation

```bash
pnpm vitest run src/lib/scans src/lib/ikas/report-service.test.ts src/app/api/scans/route.test.ts src/app/api/report/route.test.ts src/app/page.test.tsx
pnpm test
pnpm test:e2e
pnpm lint
pnpm build
git diff --check
```

Instrument mocked call counts to prove the scan/view split; do not infer it from response speed.

---

### PR C — Dashboard information architecture and responsive operations

**Objective:** Turn the snapshot reader into a focused merchant workflow.

**Files:**
- Create: `src/components/DashboardHeader.tsx`
- Create: `src/components/HealthSummary.tsx`
- Create: `src/components/RuleFilters.tsx`
- Create: `src/components/ProductIssueTable.tsx`
- Create focused component tests for each
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.test.tsx`
- Modify: `src/app/globals.css`

#### Task C1 — Design tokens

Define semantic tokens, not page-specific colors:

- canvas / surface / elevated surface
- text / muted text / border
- one interaction accent
- critical / warning / success statuses
- focus ring
- spacing, radius, shadow, and type scale

Do not copy another brand. Select the final accent after comparing it against existing app identity and ikas host chrome; document contrast results.

#### Task C2 — Header and scan action

- Show store, plan state, last successful scan, and one primary `Şimdi tara` control.
- Disable duplicate scan while a lease/run is active.
- Show scan outcome without replacing the last successful report on failure.

#### Task C3 — KPI hierarchy

Replace oversized icon cards with a compact summary row:

- Health state/score
- Critical issue count
- Affected products
- Change since previous snapshot when available

No decorative stars or glyph icons. Use one consistent icon library only if the existing dependency footprint supports it; otherwise use text-first UI.

#### Task C4 — Score product decision

Before changing the formula:

1. Create anonymized fixtures at 10 / 100 / 1000 products with equal proportional issue density.
2. Record current score behavior.
3. Choose one bounded, size-comparable model or replace the absolute score with a categorical health state.
4. RED: zero-product store has no numeric score.
5. RED: equal issue density across size bands yields comparable output.
6. Document the methodology for merchants.

Do not claim real-world frequency without production distributions.

#### Task C5 — Accessible URL-driven filters

- Wrap filters in `<nav aria-label="Kural filtresi">`.
- Keep links and URL state.
- Add `aria-current="page"` to the active link.
- Include count in the accessible label.
- Hide decorative badges from assistive technology.
- Add a non-color active cue.
- Show `Filtreyi temizle` only when a filter is active and as a secondary action.

#### Task C6 — Operational table

- Make product name the link to ikas admin.
- Add search and deterministic sort.
- Add severity and active-filter summary.
- Use pagination or bounded rendering for large snapshots.
- At 360px, use horizontal scrolling with an explicit affordance or a responsive row-card representation; never clip the final action column.
- Separate healthy-empty, filter-empty, and zero-product states.

#### PR C acceptance

- Keyboard-only completion of filter, search, sort, row inspection, scan, and CSV flows.
- No state communicated by color alone.
- 360/768/1280 visual QA.
- No internal/prototype copy.
- Dashboard source and screenshots pass independent design review.

---

### PR D — History, diff, and Pro integration

**Objective:** Make continuous monitoring the paid value while preserving Free manual reports.

**Files:**
- Create: `src/lib/scans/report-diff.ts`
- Create: `src/lib/scans/report-diff.test.ts`
- Extend: `src/lib/scans/snapshot-store.ts`
- Extend: `src/lib/scans/snapshot-store.test.ts`
- Create: `src/components/ScanHistory.tsx`
- Create: `src/components/PlanStatusCard.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.test.tsx`
- Integrate: `src/lib/billing/feature-policy.ts`

#### Task D1 — Stable diff identity

Use `productId + variantId? + ruleCode`. Test new, ongoing, and resolved issue identities. Never use translated labels as identity.

#### Task D2 — Bounded history

- Tenant partitioning is mandatory.
- Retention count and age are configurable.
- Full product payload is not retained.
- Uninstall cleanup remains blocked until the first-party webhook contract is known, but an explicit cleanup interface must exist for later wiring.

#### Task D3 — Server-side feature gating

- Free: latest manual snapshot, filters, CSV.
- Pro: history, diff, schedule, low-stock configuration, verified email summary.
- Query/header/cookie plan hints never grant access.
- Unknown licence state fails closed for Pro and does not unnecessarily break Free manual scanning.

#### Task D4 — Pro presentation

- Remove the dominant `Ücretli MVP sinyali` block.
- Present named capabilities in a restrained plan card.
- Preserve the honest distinction between current out-of-stock count and future configurable threshold.
- Show price/plan-management CTA only after Partner-panel configuration is real and first-party navigation is known.

---

## 5. Deferred external gates

These do not block PR A–D's safe code slices but block final paid release claims:

1. Authenticated signed ikas embedded launch and dashboard acceptance.
2. Partner-panel immutable Pro key, price, plan copy, region, and purchase flow.
3. First-party payment/uninstall webhook signature, canonical bytes, secret source, replay, retry, and idempotency contract.
4. Actual support channel for merchant-facing OAuth failure recovery.
5. Real catalog score-distribution benchmark before claiming score quality.

---

## 6. Review and rollout gates for every PR

1. Strict TDD with observed RED before production code.
2. Focused tests, full tests, browser E2E, lint, TypeScript/build, and `git diff --check`.
3. Independent UX/accessibility review and security/spec review.
4. Preview app-level QA; deployment `READY` alone is insufficient.
5. Verify runtime logs after smoke paths.
6. Update GitHub issue #5 body, not only comments.
7. Ask for merge approval.
8. After merge, bind production deployment to the merge SHA and repeat production smoke.
9. Keep signed ikas acceptance as a separately labelled evidence class.

---

## 7. Immediate execution order

1. Update stale issue #5 body to show PR #8 merged and PR A active.
2. Rename or recreate the current empty branch so the first slice is `fix/ui-runtime-onboarding` rather than mixing it into Phase 2A history work.
3. Implement PR A.
4. Merge PR A after approval and production verification.
5. Return to `feat/phase-2a-scan-history-diff` for PR B.
6. Implement PR C on top of the merged snapshot read model.
7. Implement PR D only after entitlement wiring and Partner plan decisions are ready enough to avoid fake pricing/plan UI.

---

## 8. Definition of “best available UI” for this release

The redesign is complete only when:

- setup and OAuth form look and behave like one product;
- authorization states truthful read-only scope and recovery information;
- no English/default framework error appears inside ikas;
- no navigation or filter action re-scans the ikas catalog;
- every displayed report has a scan identity and timestamp;
- the dashboard works at embedded widths without clipped actions;
- score/health language is size-aware, explainable, and has a zero-product state;
- filters and statuses are keyboard/screen-reader usable and not color-only;
- Free manual scan and CSV remain available;
- Pro history/diff is server-gated and never granted by client input;
- no prototype/internal experiment language is visible;
- production and signed ikas launch are verified separately with evidence.
