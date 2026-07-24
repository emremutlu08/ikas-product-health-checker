import { describe, expect, it, vi } from "vitest";
import {
  createDailySummaryEmailSender,
  isDailySummaryEmailConfigured,
  MonitoringEmailError,
} from "./email-summary";

const env = {
  RESEND_API_KEY: "re_test_secret_value",
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
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_test_secret_value");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("ikas-monitoring/delivery-1");
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
      new Response("owner@example.com re_test_secret_value private", { status: 500 }),
    );
    const sender = createDailySummaryEmailSender({ env, fetchImpl });

    await expect(sender.send({ email: "owner@example.com" }, summary, "ikas-monitoring/delivery-1")).rejects.toEqual(
      expect.objectContaining({ code: "IKAS_MONITORING_EMAIL_DELIVERY_FAILED" }),
    );
    try {
      await sender.send({ email: "owner@example.com" }, summary, "ikas-monitoring/delivery-1");
    } catch (error) {
      expect(String(error)).not.toContain("owner@example.com");
      expect(String(error)).not.toContain("re_test_secret_value");
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
