import { createHmac } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_CLIENT_SECRET, E2E_TOKEN_STORE_FILE } from "../playwright.config";

/**
 * The Free/PRO surface, exercised in a real browser against a real installation session.
 *
 * A signed launch is reproduced exactly as ikas performs it — an HMAC over storeName, merchantId
 * and timestamp — against a seeded development token file, so the session is established through
 * the same route production uses rather than through a test-only back door. No licence backend is
 * reachable from a browser test, so the entitlement resolver correctly reports an unreadable
 * licence, and this spec asserts the fail-closed rendering that follows: Free coverage only, and
 * no PRO capability presented as usable.
 */

const AUTHORIZED_APP_ID = "playwright-authorized-app";
const MERCHANT_ID = "playwright-merchant";
const STORE_NAME = "dev-emre2";

function seedInstallationToken() {
  mkdirSync(path.dirname(E2E_TOKEN_STORE_FILE), { recursive: true });
  writeFileSync(
    E2E_TOKEN_STORE_FILE,
    JSON.stringify({
      [AUTHORIZED_APP_ID]: {
        authorizedAppId: AUTHORIZED_APP_ID,
        merchantId: MERCHANT_ID,
        storeName: STORE_NAME,
        accessToken: "playwright-access-token",
        refreshToken: "playwright-refresh-token",
        tokenType: "Bearer",
        // Far enough out that the token service has no reason to attempt a refresh, which would
        // otherwise invalidate a seeded token that no OAuth backend can renew.
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      },
    }),
    "utf8",
  );
}

function signedLaunchPath() {
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", E2E_CLIENT_SECRET)
    .update(`${STORE_NAME}${MERCHANT_ID}${timestamp}`)
    .digest("hex");
  const params = new URLSearchParams({
    storeName: STORE_NAME,
    merchantId: MERCHANT_ID,
    timestamp,
    signature,
    authorizedAppId: AUTHORIZED_APP_ID,
  });
  return `/?${params.toString()}`;
}

async function launchAuthenticated(page: Page) {
  seedInstallationToken();
  await page.goto(signedLaunchPath());
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
}

test.afterAll(() => {
  rmSync(E2E_TOKEN_STORE_FILE, { force: true });
});

test("renders the Free and PRO comparison from the resolved capability policy", async ({ page }) => {
  await launchAuthenticated(page);
  await page.goto("/plan");

  await expect(page.getByRole("heading", { name: "Free ve PRO karşılaştırması" })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Free" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "PRO" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Durum" })).toBeVisible();

  for (const capability of [
    "Manuel katalog taraması",
    "Mağaza sağlık skoru ve sorun panosu",
    "CSV dışa aktarma",
    "Zamanlanmış günlük tarama",
    "Tarama geçmişi ve sorun farkları",
    "Düşük stok eşiği ayarı",
    "Günlük e-posta özeti",
    "Düşük stok eşik ve toparlanma bildirimleri",
    "Güvenli tekil SKU, fiyat ve stok düzeltmesi",
    "Toplu düzeltme",
  ]) {
    await expect(table.getByRole("rowheader", { name: new RegExp(capability) })).toBeVisible();
  }
});

test("never invents a price, currency or trial for the paid package", async ({ page }) => {
  await launchAuthenticated(page);
  await page.goto("/plan");

  const body = await page.locator("body").innerText();
  for (const invented of ["₺", "USD", "EUR", "/ay", "ücretsiz deneme"]) {
    expect(body).not.toContain(invented);
  }
  await expect(
    page.getByText("fiyatı, para birimi, faturalama aralığı ve deneme süresi burada", {
      exact: false,
    }),
  ).toBeVisible();
});

test("fails closed to Free coverage when the licence cannot be read", async ({ page }) => {
  await launchAuthenticated(page);
  await page.goto("/plan");

  await expect(page.getByText("Plan bilgisi şu anda doğrulanamadı", { exact: false })).toBeVisible();
  // Every paid row is labelled as unavailable rather than shown as something to click.
  await expect(page.locator("main").getByRole("button")).toHaveCount(0);
});

test("offers no correction control while the write surface is not open", async ({ page }) => {
  await launchAuthenticated(page);
  await page.goto("/corrections");

  await expect(page.getByRole("heading", { level: 1, name: "Güvenli düzeltmeler" })).toBeVisible();
  await expect(page.getByText("Düzeltmeler şu anda kullanılamıyor", { exact: false })).toBeVisible();
  await expect(page.locator("input")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Önizle|Onayla/ })).toHaveCount(0);
});

test("keeps the comparison table inside its own horizontal scroll container on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await launchAuthenticated(page);
  await page.goto("/plan");

  await expect(page.getByRole("table")).toBeVisible();
  // The behaviour that matters to a merchant: the table scrolls, the page underneath does not.
  const container = page.locator("main div.overflow-x-auto");
  const scrollable = await container.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(scrollable).toBe(true);

  // Asserted against the app's own root rather than `document.scrollingElement`: the dev server
  // renders its tooling into a shadow-DOM portal that contributes width the product does not.
  const rootOverflow = await page.locator("main").evaluate(
    (element) => element.getBoundingClientRect().width - window.innerWidth,
  );
  expect(rootOverflow).toBeLessThanOrEqual(0);
});
