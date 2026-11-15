import { describe, expect, it, vi } from "vitest";
import {
  createDailySummaryEmailSender,
  isDailySummaryEmailConfigured,
  MonitoringEmailError,
} from "./email-summary";

const env = {
  EMAIL_API_TOKEN: "cf_test_secret_value",
  CLOUDFLARE_ACCOUNT_ID: "fa9f73e26e04ae80f02ac35d16eaa837",
  IKAS_EMAIL_FROM: "Product Health <health@example.com>",
};

const summary = {
  generatedAt: "2026-07-22T10:00:00.000Z",
  score: 82,
  state: "attention" as const,
  productCount: 12,
  issueCount: 4,
  lowStockCount: 2,
  historyUrl: "https://app.example.com/history",
};

describe("daily summary email adapter", () => {
  it("sends only the verified recipient and safe aggregate summary", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ id: "email-1" }, { status: 200 }));
    const sender = createDailySummaryEmailSender({ env, fetchImpl });

    await sender.send({ email: "owner@example.com" }, summary, "ikas-monitoring/delivery-1");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/fa9f73e26e04ae80f02ac35d16eaa837/email/sending/send");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cf_test_secret_value");
    expect(JSON.parse(init?.body as string).headers).toEqual({ "X-Delivery-Key": "ikas-monitoring/delivery-1" });
    expect(JSON.parse(init?.body as string).from).toEqual({ address: "health@example.com", name: "Product Health" });
    const body = JSON.parse(init?.body as string);
    expect(body.to).toEqual(["owner@example.com"]);
    expect(body.text).toContain("82");
    expect(body.text).toContain("Düşük stok uyarısı: 2");
    expect(body.text).toContain("Durum: Dikkat gerekiyor");
    expect(body.text).toContain("22.07.2026");
    expect(body.text).toContain("https://app.example.com/history");
    expect(JSON.stringify(body)).not.toContain("authorizedAppId");
    expect(JSON.stringify(body)).not.toContain("merchantId");
    expect(JSON.stringify(body)).not.toContain("productRows");
  });

  it("returns generic errors without provider body, secret or recipient", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("owner@example.com cf_test_secret_value private", { status: 500 }),
    );
    const sender = createDailySummaryEmailSender({ env, fetchImpl });

    await expect(sender.send({ email: "owner@example.com" }, summary, "ikas-monitoring/delivery-1")).rejects.toEqual(
      expect.objectContaining({ code: "IKAS_MONITORING_EMAIL_DELIVERY_FAILED" }),
    );
    try {
      await sender.send({ email: "owner@example.com" }, summary, "ikas-monitoring/delivery-1");
    } catch (error) {
      expect(String(error)).not.toContain("owner@example.com");
      expect(String(error)).not.toContain("cf_test_secret_value");
      expect(String(error)).not.toContain("private");
    }
  });

  it("fails closed when provider configuration is missing or invalid", () => {
    expect(isDailySummaryEmailConfigured(env)).toBe(true);
    expect(isDailySummaryEmailConfigured({})).toBe(false);
    expect(isDailySummaryEmailConfigured({ ...env, IKAS_EMAIL_FROM: "not an email" })).toBe(false);
    expect(() => createDailySummaryEmailSender({ env: {} })).toThrow(MonitoringEmailError);
    expect(() => createDailySummaryEmailSender({ env: { ...env, IKAS_EMAIL_FROM: "not an email" } })).toThrow(
      MonitoringEmailError,
    );
  });
});
