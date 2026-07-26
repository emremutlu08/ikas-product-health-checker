import { describe, expect, it, vi } from "vitest";
import {
  ALERT_RETRY_BASE_BACKOFF_MS,
  ALERT_RETRY_MAX_BACKOFF_MS,
  backoffFor,
  buildLowStockAlertEmail,
  deliverLowStockAlerts,
  MAX_LISTED_ALERT_LINES,
  scanAlertIdempotencyKey,
} from "./alert-notifier";
import type { TransactionalEmailSender } from "@/lib/monitoring/email-summary";
import { MemoryAlertOutboxStore } from "./alert-store";
import type { LowStockAlertEvent } from "./low-stock-alerts";

const tenant = { authorizedAppId: "app-1", merchantId: "merchant-1" } as const;
const recipient = { email: "owner@example.com" };
const NOW = 1_753_000_000_000;

function event(overrides: Partial<LowStockAlertEvent> = {}): LowStockAlertEvent {
  return {
    kind: "crossing",
    entryKey: "product-1|variant-1|location-1",
    productId: "product-1",
    productName: "Classic Laptop Sleeve",
    variantId: "variant-1",
    stockLocationId: "location-1",
    stockCount: 2,
    threshold: 5,
    ...overrides,
  };
}

type Send = TransactionalEmailSender["send"];

function dependencies(sendImpl?: Send) {
  const send = vi.fn<Send>(sendImpl ?? (async () => undefined));
  return {
    outbox: new MemoryAlertOutboxStore(),
    sender: { send },
    now: () => NOW,
    send,
  };
}

describe("buildLowStockAlertEmail", () => {
  it("lists crossings and recoveries separately and names the store", () => {
    const email = buildLowStockAlertEmail(
      [event(), event({ kind: "recovery", stockCount: 12, variantLabel: "Varyant 2" })],
      "dev-emre2",
    );

    expect(email.subject).toContain("dev-emre2");
    expect(email.text).toContain("Eşiğin altına düşen varyantlar (1)");
    expect(email.text).toContain("Yeniden eşiğin üzerine çıkan varyantlar (1)");
    expect(email.text).toContain("Classic Laptop Sleeve (Varyant 2)");
    expect(email.text).toContain("stok verileriniz değiştirilmez");
  });

  it("caps the listed lines instead of mailing an unbounded catalog", () => {
    const events = Array.from({ length: MAX_LISTED_ALERT_LINES + 5 }, (_, index) =>
      event({ productName: `Ürün ${index}` }),
    );

    const email = buildLowStockAlertEmail(events, "dev-emre2");

    expect(email.text).toContain("ve 5 tane daha");
    expect(email.text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(
      MAX_LISTED_ALERT_LINES + 1,
    );
  });
});

describe("backoffFor", () => {
  it("grows with the attempt and stops at the ceiling", () => {
    expect(backoffFor(1)).toBe(ALERT_RETRY_BASE_BACKOFF_MS);
    expect(backoffFor(2)).toBe(ALERT_RETRY_BASE_BACKOFF_MS * 2);
    expect(backoffFor(99)).toBe(ALERT_RETRY_MAX_BACKOFF_MS);
  });
});

describe("deliverLowStockAlerts", () => {
  it("sends one grouped message and marks it delivered", async () => {
    const deps = dependencies();

    await expect(
      deliverLowStockAlerts(tenant, recipient, [event()], "scan-1", "dev-emre2", deps),
    ).resolves.toEqual({ status: "sent" });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send.mock.calls[0]![2]).toBe(scanAlertIdempotencyKey("scan-1"));
  });

  it("does not send a second copy when the same scan is delivered again", async () => {
    const deps = dependencies();
    await deliverLowStockAlerts(tenant, recipient, [event()], "scan-1", "dev-emre2", deps);

    await expect(
      deliverLowStockAlerts(tenant, recipient, [event()], "scan-1", "dev-emre2", deps),
    ).resolves.toEqual({ status: "skipped", reason: "already_sent" });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing at all when there is nothing to say", async () => {
    const deps = dependencies();

    await expect(
      deliverLowStockAlerts(tenant, recipient, [], "scan-1", "dev-emre2", deps),
    ).resolves.toEqual({ status: "skipped", reason: "no_events" });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("reuses the same idempotency key after a provider timeout so a retry cannot duplicate", async () => {
    const deps = dependencies(async () => {
      throw new Error("provider timeout");
    });

    await expect(
      deliverLowStockAlerts(tenant, recipient, [event()], "scan-1", "dev-emre2", deps),
    ).resolves.toEqual({ status: "failed" });

    // The next attempt is held in backoff, and when it runs it presents the identical key.
    await expect(
      deliverLowStockAlerts(tenant, recipient, [event()], "scan-1", "dev-emre2", deps),
    ).resolves.toEqual({ status: "skipped", reason: "backoff" });

    const later = {
      ...deps,
      now: () => NOW + ALERT_RETRY_BASE_BACKOFF_MS,
    };
    await deliverLowStockAlerts(tenant, recipient, [event()], "scan-1", "dev-emre2", later);
    expect(deps.send.mock.calls.map((call) => call[2])).toEqual([
      scanAlertIdempotencyKey("scan-1"),
      scanAlertIdempotencyKey("scan-1"),
    ]);
  });

  it("gives the next scan its own delivery decision", async () => {
    const deps = dependencies();
    await deliverLowStockAlerts(tenant, recipient, [event()], "scan-1", "dev-emre2", deps);

    await expect(
      deliverLowStockAlerts(tenant, recipient, [event()], "scan-2", "dev-emre2", deps),
    ).resolves.toEqual({ status: "sent" });
    expect(deps.send).toHaveBeenCalledTimes(2);
  });

  it("never mails an address that is not the verified recipient it was given", async () => {
    const deps = dependencies();
    await deliverLowStockAlerts(tenant, recipient, [event()], "scan-1", "dev-emre2", deps);

    expect(deps.send.mock.calls[0]![0]).toBe(recipient);
  });
});
