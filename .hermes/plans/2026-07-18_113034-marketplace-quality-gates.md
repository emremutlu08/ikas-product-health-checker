# Marketplace Quality Gates Implementation Plan

> **For Hermes:** Execute task-by-task with strict RED-GREEN-REFACTOR and independent pre-commit review.

**Goal:** Close the verified QA gaps without weakening the live-only, tenant-bound production architecture.

**Architecture:** Keep production report behavior unchanged. Add browser smoke coverage for the unauthenticated installation and authorization surfaces, add server-rendered dashboard regression coverage by mocking only existing session/report boundaries, and expand CSV route/error assertions where coverage is incomplete. Run browser tests against a local Next.js server with non-secret test-only environment values.

**Tech Stack:** Next.js 16.2.10, React 19.2.4, TypeScript, Vitest 4.1.10, Playwright Test.

**Execution model:** OpenAI Codex `gpt-5.6-sol`, high reasoning.

---

### Task 1: Add dashboard server-render regression tests

**Objective:** Prove the authenticated dashboard renders summary metrics, rule links, filtered rows, CSV link, and ikas product edit links without adding a production mock path.

**Files:**
- Create: `src/app/page.test.tsx`
- Modify only if a real defect is exposed: `src/app/page.tsx`

**Steps:**
1. Mock `getSession`, `readInstallationSession`, `getProductHealthReport`, launch-auth redirect lookup, and `IkasAppBridgeReady` at existing boundaries.
2. Write a failing test for authenticated dashboard HTML and run `pnpm vitest run src/app/page.test.tsx`.
3. Add the minimum test harness or production correction required to pass.
4. Add a failing filter test proving `?rule=...` limits product rows while preserving tenant-free CSV/report links.
5. Run the focused test and the full Vitest suite.

### Task 2: Strengthen CSV route behavior coverage

**Objective:** Verify download headers and safe mappings for auth, token-backend, upstream, and unexpected failures.

**Files:**
- Modify: `src/app/api/report/route.test.ts`
- Modify only if a real defect is exposed: `src/app/api/report.csv/route.ts`

**Steps:**
1. Add one missing assertion at a time and run the focused test to confirm RED where behavior is absent.
2. Implement only required route corrections.
3. Confirm success responses include the expected filename, content type, and private/no-store caching.
4. Confirm failures return the expected status/code and remain private/no-store.

### Task 3: Add Playwright public-flow smoke tests

**Objective:** Exercise the real browser against the local Next.js app for installation-required UI, authorization form normalization, safe failure rendering, and protected report endpoints.

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `playwright.config.ts`
- Create: `e2e/public-flow.spec.ts`
- Create: `.github/workflows/quality.yml`
- Modify: `.gitignore`

**Steps:**
1. Add `@playwright/test` and scripts `test:e2e` / `test:all`.
2. Configure a local web server with a test cookie password and exact localhost deploy origin.
3. Write the smoke spec before installing/running the browser; confirm the command initially fails because infrastructure is absent.
4. Install the Chromium runtime required by Playwright.
5. Add a least-privilege GitHub Actions workflow that runs the same tests, lint, and build on pull requests and `main`.
6. Run E2E and fix only observed defects.
7. Ensure generated Playwright artifacts are ignored.

### Task 4: Update QA documentation

**Objective:** Document what is automated versus what still requires a signed ikas launch and real development store.

**Files:**
- Modify: `README.md`
- Modify: `docs/ikas-app-dev-workflow.md`

**Steps:**
1. Add exact `pnpm test:e2e` and `pnpm test:all` commands.
2. Add an explicit automated/manual verification matrix.
3. Preserve the no-mutation and live-only runtime rules.

### Task 5: Verify, review, and open PR

**Objective:** Deliver a reviewable, green change set.

**Validation:**
- `pnpm test`
- `pnpm test:e2e`
- `pnpm lint`
- `pnpm build`
- `git diff --check`

**Steps:**
1. Review the diff for secrets and accidental production test hooks.
2. Run an independent reviewer subagent against the final diff.
3. Fix blocking findings and rerun all gates.
4. Commit with a conventional verified message.
5. Push `test/marketplace-quality-gates` and open a PR against `main`.
6. Report PR URL, exact test counts, and any remaining live-only manual gate.

## Non-goals and constraints

- Do not introduce a production mock-data fallback.
- Do not add a test-only authentication backdoor or seeding route.
- Do not mutate ikas product, stock, price, payment, customer, or order data.
- Do not claim a live embedded verification unless the signed ikas launch is actually exercised.
