import { expect, test, type Page } from "@playwright/test";

/**
 * Browser-level checks for the things a server-rendered string cannot prove: that the design
 * tokens actually resolve, that keyboard focus is visibly drawn, and that the embedded iframe
 * widths this app ships into do not clip or overflow.
 *
 * Only surfaces reachable without an installation session are exercised here. The
 * authenticated dashboard is covered by `dashboard-visual.spec.ts`, which renders the real
 * components into this same page rather than adding a seed route or an auth bypass.
 */

const EMBEDDED_WIDTHS = [360, 768, 1280];

const SETUP_HEADING = "Kurulumu tamamla";
const SETUP_CTA = "ikas ile güvenli şekilde bağlan";

/**
 * Navigates to the setup screen and returns *its* `<main>`.
 *
 * `page.goto` resolves as soon as the document responds, which is not the same moment the
 * route is settled: Next streams `app/loading.tsx` first, and that fallback ships its own
 * full-height `<main>`. For a beat the two coexist, so a bare `locator("main")` is ambiguous
 * and a `Tab` press lands on whatever the fallback happens to expose. Both are real states of
 * a real page — the fix is for the test to say which one it means, not to paper over the
 * transition. Every assertion below therefore runs against the main that contains the setup
 * CTA, after the setup heading has rendered.
 */
async function gotoSetupScreen(page: Page) {
  await page.goto("/");

  const cta = page.getByRole("link", { name: SETUP_CTA });
  await expect(page.getByRole("heading", { name: SETUP_HEADING })).toBeVisible();
  await expect(cta).toBeVisible();

  return { cta, main: page.locator("main").filter({ has: cta }) };
}

test("resolves the semantic canvas token instead of a hard-coded page colour", async ({ page }) => {
  const { main } = await gotoSetupScreen(page);

  // --color-canvas is #f6f7f9.
  await expect(main).toHaveCSS("background-color", "rgb(246, 247, 249)");
});

test("keeps the loading fallback on the same token system as the screen it precedes", async ({
  page,
}) => {
  // The transition above is a real screen a merchant sees inside the ikas iframe. It must not
  // be a second visual system, so it is asserted rather than merely waited out.
  await page.goto("/");
  const loadingMain = page.locator("main").filter({ hasText: "Sayfa hazırlanıyor" });

  if (await loadingMain.count()) {
    await expect(loadingMain).toHaveCSS("background-color", "rgb(246, 247, 249)");
  }

  const { main } = await gotoSetupScreen(page);
  await expect(main).toHaveCSS("background-color", "rgb(246, 247, 249)");
  // Once settled the fallback is gone, so exactly one main remains.
  await expect(page.locator("main")).toHaveCount(1);
});

test("draws a visible focus ring when the primary action is reached by keyboard", async ({
  page,
}) => {
  const { cta } = await gotoSetupScreen(page);

  await page.keyboard.press("Tab");
  await expect(cta).toBeFocused();

  const outline = await cta.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
  });

  expect(outline.style).toBe("solid");
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  // --color-focus-ring is #15607a.
  expect(outline.color).toBe("rgb(21, 96, 122)");
});

for (const width of EMBEDDED_WIDTHS) {
  test(`fits the setup surface at ${width}px without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const { cta } = await gotoSetupScreen(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The primary action must be fully inside the viewport, not merely present in the DOM.
    await expect(cta).toBeVisible();
    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    // Comfortably tappable at embedded widths.
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
}

test("shows no prototype or internal language on the public surface", async ({ page }) => {
  // Read the settled screen: asserting against the loading fallback would pass vacuously.
  const { main } = await gotoSetupScreen(page);

  const body = await main.innerText();
  for (const word of ["MVP", "ilk sürüm", "Ücretli MVP sinyali", "prototip"]) {
    expect(body).not.toContain(word);
  }
});

test("a dashboard navigation never reaches the scan endpoint", async ({ page }) => {
  const scanRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/scans")) scanRequests.push(request.method());
  });

  // Filter, search, sort and pagination are all plain navigations on the same route.
  for (const query of ["", "?rule=missing_sku", "?q=kazak", "?sort=name", "?page=2"]) {
    await page.goto(`/${query}`);
  }

  expect(scanRequests).toEqual([]);
});
