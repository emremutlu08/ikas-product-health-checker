import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A page that renders one tenant's data must never be served from a cache.
 *
 * Four of the five such pages said so explicitly and `/history` did not. Reading the session
 * forces a dynamic render on its own, so the odd one out was not actually being cached — but the
 * guarantee was resting on a side effect of how the page happens to be written, which is a thin
 * thing to leave between a merchant and someone else's scan history.
 *
 * The subjects are discovered rather than listed, so a page added later is covered the day it is
 * written instead of the day someone remembers to add it here.
 */

const APP_DIR = path.join(process.cwd(), "src", "app");

function pageFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "api") continue;
      found.push(...pageFiles(full));
      continue;
    }
    if (entry.name === "page.tsx") found.push(full);
  }
  return found;
}

const tenantPages = pageFiles(APP_DIR)
  .map((file) => ({ file, source: readFileSync(file, "utf8") }))
  // The session is what makes a response tenant-specific; a page that never reads it renders the
  // same bytes for everyone and may legitimately be cached.
  .filter(({ source }) => source.includes("readInstallationSession"))
  .map(({ file, source }) => ({ name: path.relative(APP_DIR, file), source }));

describe("tenant-scoped page caching", () => {
  it("finds the tenant pages to check", () => {
    expect(tenantPages.length).toBeGreaterThanOrEqual(5);
    expect(tenantPages.map((page) => page.name)).toContain(path.join("history", "page.tsx"));
  });

  it.each(tenantPages.map((page) => page.name))(
    "%s opts out of caching because it renders one tenant's data",
    (name) => {
      const page = tenantPages.find((candidate) => candidate.name === name)!;

      expect(page.source).toMatch(/export const dynamic = ["']force-dynamic["']/);
    },
  );
});
