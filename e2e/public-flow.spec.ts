import { expect, test } from "@playwright/test";

const supportId = "25f30636-83db-4e72-a239-90b3a9877a56";

test("shows installation-required UI and opens the store authorization form", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Kurulumu tamamla" })).toBeVisible();
  await expect(page.getByText("Ürün veya stok bilgileri değiştirilmez", { exact: false })).toBeVisible();
  await expect(page.getByRole("link")).toHaveCount(1);

  await page.getByRole("link", { name: "ikas ile güvenli şekilde bağlan" }).click();
  await expect(page).toHaveURL(/\/authorize-store$/);
  await expect(page.getByRole("heading", { name: "Mağazanı bağla" })).toBeVisible();
  await expect(page.getByText("Yalnızca ürün ve stok bilgilerini okur.")).toBeVisible();
  await expect(page.locator("main")).toHaveClass(/bg-slate-50/);
});

test("normalizes a full ikas admin URL to the store subdomain", async ({ page }) => {
  await page.goto("/authorize-store");
  const input = page.getByLabel("Mağaza adı");

  await input.fill("https://dev-emre2.myikas.com/admin/product");
  await input.blur();

  await expect(input).toHaveValue("dev-emre2");
});

test("renders allowlisted OAuth failures and copies a validated support code", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(
    `/authorize-store?status=fail&reason=token_store_unavailable&errorId=${supportId}`,
  );

  await expect(page.getByText("Güvenli bağlantı deposu hazır değil.")).toBeVisible();
  await expect(page.getByText(`Destek kodu: ${supportId}`)).toBeVisible();
  await page.getByRole("button", { name: "Kopyala" }).click();
  await expect(page.getByRole("button", { name: "Kopyalandı" })).toBeVisible();
  await expect(page.getByText("Destek kodu kopyalandı.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(supportId);
});

test("shows a manual-copy fallback when clipboard access is denied", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")),
      },
    });
  });
  await page.goto(
    `/authorize-store?status=fail&reason=token_store_unavailable&errorId=${supportId}`,
  );

  await page.getByRole("button", { name: "Kopyala" }).click();
  await expect(page.getByText("Kod kopyalanamadı. Destek kodunu seçip elle kopyala.")).toBeVisible();
});

test("keeps report endpoints private without an installation session", async ({ request }) => {
  for (const path of ["/api/report", "/api/report.csv"]) {
    const response = await request.get(path);

    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "IKAS_LIVE_AUTH_REQUIRED" });
  }
});
