import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

import { buildDashboardHarness, harnessRuleMappingIsConsistent } from "./dashboard-harness";

/**
 * Renders the dashboard harness and writes it where the Playwright spec can read it.
 *
 * This runs under Vitest because Vitest is the project's configured React transform; Playwright
 * compiles JSX into its own element descriptors and cannot render the app's components at all.
 * `e2e/dashboard-visual.spec.ts` runs this file through the Vitest binary before its first test,
 * so the artifact is always generated from the current source rather than checked in and left to
 * rot. It is excluded from the normal `vitest run` by the root config's `e2e/**` exclude, and is
 * only ever reached through the dedicated config beside it. The `.emit.ts` suffix keeps it out of
 * Playwright's own glob, which would otherwise try — and fail — to compile it.
 *
 * The assertions below are not ceremony: a harness that silently renders an empty table would
 * make every layout assertion downstream pass vacuously.
 */

export const HARNESS_ARTIFACT = path.resolve(
  import.meta.dirname,
  "../../test-results/dashboard-harness.json",
);

test("emits dashboard markup for the browser-level layout and accessibility spec", () => {
  expect(harnessRuleMappingIsConsistent()).toBe(true);

  const harness = buildDashboardHarness();

  // A full page of rows, a real admin link, and the controls the spec goes looking for.
  expect(harness.renderedRowCount).toBe(25);
  expect(harness.html).toContain(`https://${harness.storeName}.myikas.com/admin/product/edit/`);
  expect(harness.html).toContain(harness.lastProductName);
  expect(harness.html).toContain("Şimdi tara");
  expect(harness.html).toContain('id="product-search"');
  expect(harness.html).toContain('aria-label="Ürün sorunları tablosu"');

  // Nothing merchant-facing may carry roadmap or prototype language into the harness either.
  for (const word of ["MVP", "prototip", "V1", "Planlanan"]) {
    expect(harness.html).not.toContain(word);
  }

  mkdirSync(path.dirname(HARNESS_ARTIFACT), { recursive: true });
  writeFileSync(HARNESS_ARTIFACT, JSON.stringify(harness), "utf8");
});
