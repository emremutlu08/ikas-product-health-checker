import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import type { DashboardHarness } from "./fixtures/dashboard-harness";

/**
 * Visual and accessibility checks for the authenticated dashboard at the widths it is embedded
 * at, without a production route, an auth bypass, a mock or a seed endpoint.
 *
 * The real app is loaded first so the page carries the compiled Tailwind stylesheet and the
 * real token values; only `document.body` is then replaced with markup produced by the real
 * dashboard components. See `fixtures/dashboard-harness.ts` for why this shape was chosen, and
 * why the markup arrives as an artifact rather than as a direct import.
 *
 * Everything asserted here is a property of CSS applied to real markup — overflow, focus rings,
 * landmark names, reachability of the rightmost column — which is exactly the class of thing
 * the component tests cannot see.
 */

const EMBEDDED_WIDTHS = [360, 768, 1280] as const;

/** The narrowest width, where the table is expected to scroll rather than fit. */
const NARROW_WIDTH = 360;

// `__dirname`, not `import.meta`: Playwright compiles specs to CommonJS.
const REPO_ROOT = path.resolve(__dirname, "..");
const HARNESS_ARTIFACT = path.join(REPO_ROOT, "test-results/dashboard-harness.json");

let harness: DashboardHarness;

test.beforeAll(() => {
  // Regenerated from source on every run. The type-only import above is erased, so the
  // components themselves are never loaded into Playwright's transform.
  execFileSync(
    path.join(REPO_ROOT, "node_modules/.bin/vitest"),
    ["run", "--config", "e2e/fixtures/harness.vitest.config.ts"],
    { cwd: REPO_ROOT, stdio: "pipe" },
  );

  harness = JSON.parse(readFileSync(HARNESS_ARTIFACT, "utf8")) as DashboardHarness;
  expect(harness.renderedRowCount).toBeGreaterThan(0);
});

async function mountDashboard(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });

  // The real app, for the real stylesheet. Waiting for the settled screen matters here for the
  // same reason it does in `design-system.spec.ts`: swapping the body mid-transition would race
  // Next's own render.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Kurulumu tamamla" })).toBeVisible();

  const stylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links.map((link) => (link as HTMLLinkElement).href),
  );
  expect(stylesheets.length).toBeGreaterThan(0);

  // Start a fresh test document rather than replacing nodes owned by Next/React. The dashboard
  // markup still uses the real components and the absolute stylesheet links still load the exact
  // CSS compiled by the running app, but no hydrator remains behind to race or mutate the harness.
  const stylesheetLinks = stylesheets
    .map((href) => `<link rel="stylesheet" href="${href.replaceAll('"', "&quot;")}">`)
    .join("");
  await page.setContent(
    `<!doctype html><html lang="tr"><head>${stylesheetLinks}</head><body>${harness.html}</body></html>`,
    { waitUntil: "networkidle" },
  );

  await expect(page.getByRole("heading", { level: 1, name: "Ürün Sağlığı" })).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(246, 247, 249)");
}

/** Horizontal overflow of the document itself, which is the thing an iframe actually clips. */
async function viewportOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function focusRingOf(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.outlineColor,
      offset: style.outlineOffset,
      style: style.outlineStyle,
      width: style.outlineWidth,
    };
  });
}

async function expectWithinViewport(target: Locator, width: number) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
}

for (const width of EMBEDDED_WIDTHS) {
  test.describe(`dashboard at ${width}px`, () => {
    test("does not overflow the viewport horizontally", async ({ page }) => {
      await mountDashboard(page, width);

      // The table is allowed to scroll inside its own region; the page is not. A merchant in
      // the ikas iframe cannot scroll the document sideways to recover clipped content.
      expect(await viewportOverflow(page)).toBeLessThanOrEqual(1);
    });

    test("keeps the primary scan action and the search control usable", async ({ page }) => {
      await mountDashboard(page, width);

      const scan = page.getByRole("button", { name: "Şimdi tara" });
      await expect(scan).toBeVisible();
      await expect(scan).toBeEnabled();
      await expectWithinViewport(scan, width);
      const scanBox = await scan.boundingBox();
      // Tappable at an embedded width, not merely present.
      expect(scanBox!.height).toBeGreaterThanOrEqual(44);

      const search = page.getByLabel("Ürün ara");
      await expect(search).toBeVisible();
      await expectWithinViewport(search, width);
      const searchBox = await search.boundingBox();
      expect(searchBox!.height).toBeGreaterThanOrEqual(44);

      // Exact, because Playwright matches accessible names by substring and "Ara" is inside
      // "Şimdi tara".
      const submit = page.getByRole("button", { exact: true, name: "Ara" });
      await expect(submit).toBeVisible();
      await expectWithinViewport(submit, width);
    });

    test("draws a visible focus ring on every control reached by keyboard", async ({ page }) => {
      await mountDashboard(page, width);

      // Focused rather than clicked: these are a POST form and a GET form, and a test should
      // not depend on what submitting them would do.
      for (const control of [
        page.getByRole("button", { name: "Şimdi tara" }),
        page.getByLabel("Ürün ara"),
        page.getByRole("link", { name: "CSV indir" }),
      ]) {
        await control.focus();
        await expect(control).toBeFocused();

        const ring = await focusRingOf(control);
        expect(ring.style).toBe("solid");
        expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
        // --color-focus-ring is #15607a.
        expect(ring.color).toBe("rgb(21, 96, 122)");
      }
    });

    test("names its landmarks so the regions are distinguishable", async ({ page }) => {
      await mountDashboard(page, width);

      await expect(page.getByRole("main")).toHaveCount(1);

      // Each panel is a section with an accessible name, so a screen-reader user can tell the
      // health summary from the rule list from the table.
      await expect(page.getByRole("region", { name: "Mağaza sağlığı özeti" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Ürün sorunları tablosu" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Kural filtresi" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Sayfalama" })).toBeVisible();

      await expect(page.getByRole("heading", { level: 1, name: "Ürün Sağlığı" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Sorunlu ürünler" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Kurallar" })).toBeVisible();
    });

    test("keeps the last product's admin link reachable", async ({ page }) => {
      await mountDashboard(page, width);

      // The rightmost columns are the ones a narrow viewport threatens. The product name is
      // the link into ikas admin, so if any row's link becomes unreachable the table has
      // stopped being operable — checked on the last rendered row, the worst case for both
      // vertical and horizontal position.
      const link = page.getByRole("link", { name: harness.lastProductName });
      await expect(link).toHaveAttribute(
        "href",
        new RegExp(`^https://${harness.storeName}\\.myikas\\.com/admin/product/edit/`),
      );

      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeVisible();
      await expectWithinViewport(link, width);

      // Scrolling to it must not have dragged the document sideways.
      expect(await viewportOverflow(page)).toBeLessThanOrEqual(1);
    });
  });
}

test(`treats the table's horizontal scroll at ${NARROW_WIDTH}px as intentional and focusable`, async ({
  page,
}) => {
  await mountDashboard(page, NARROW_WIDTH);

  const region = page.getByRole("region", { name: "Ürün sorunları tablosu" });

  const scroll = await region.evaluate((element) => ({
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
    scrollWidth: element.scrollWidth,
    tabIndex: element.tabIndex,
  }));

  // A scrolling region is only acceptable if it is a real, announced, keyboard-operable region.
  // Overflow that is merely clipped, or scrollable only by pointer, is a defect.
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
  expect(scroll.overflowX).toBe("auto");
  expect(scroll.tabIndex).toBe(0);

  // And a sighted merchant has to be told it scrolls.
  await expect(page.getByText("Tabloyu yatay kaydırarak tüm sütunları görebilirsiniz.")).toBeVisible();

  await region.focus();
  await expect(region).toBeFocused();
  const ring = await focusRingOf(region);
  expect(ring.style).toBe("solid");
  expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);

  // The region scrolls to its end without the document following it sideways.
  await region.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  expect(await viewportOverflow(page)).toBeLessThanOrEqual(1);
});

test("keeps the horizontal-scroll explanation visible when the table still overflows at 768px", async ({
  page,
}) => {
  await mountDashboard(page, 768);

  const region = page.getByRole("region", { name: "Ürün sorunları tablosu" });
  const scrolls = await region.evaluate((element) => element.scrollWidth > element.clientWidth + 1);

  expect(scrolls).toBe(true);
  await expect(page.getByText("Tabloyu yatay kaydırarak tüm sütunları görebilirsiniz.")).toBeVisible();
});

test(`fits the table without a scroll region at the widest embedded width`, async ({ page }) => {
  await mountDashboard(page, 1280);

  const region = page.getByRole("region", { name: "Ürün sorunları tablosu" });
  const scroll = await region.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));

  // At 1280 the 720px minimum table width is comfortable, so nothing should be hidden behind a
  // scroll the merchant has to discover.
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
  await expect(page.getByText("Tabloyu yatay kaydırarak tüm sütunları görebilirsiniz.")).toBeHidden();
});
