import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * A one-file Vitest project whose only job is to render the dashboard harness for
 * `e2e/dashboard-visual.spec.ts`.
 *
 * The root config excludes `e2e/**` so Playwright's specs never get picked up by `vitest run`.
 * That exclusion is right, and this config does not weaken it: it names the single emitter file
 * explicitly rather than re-including the directory.
 *
 * The emitter is named `.emit.ts` rather than `.test.ts` for the mirror-image reason — Playwright
 * claims every `.test.ts` under `e2e/`, and it cannot compile a file that renders the components.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../../src"),
    },
  },
  test: {
    include: [path.resolve(import.meta.dirname, "dashboard-harness.emit.ts")],
    root: path.resolve(import.meta.dirname, "../.."),
  },
});
