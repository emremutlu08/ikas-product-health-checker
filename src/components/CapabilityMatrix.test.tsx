import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveCapabilityMatrix, type RolloutSignals } from "@/lib/billing/capability-catalog";
import { CapabilityMatrix } from "./CapabilityMatrix";

function signals(overrides: Partial<RolloutSignals> = {}): RolloutSignals {
  return {
    productWritesEnabled: false,
    bulkWritesEnabled: false,
    schedulerEnabled: false,
    emailDeliveryConfigured: false,
    verifiedRecipientConfigured: false,
    ...overrides,
  };
}

function render(entitlement: { tier: "free" | "pro"; state: "active" | "unknown" }, rollout = signals()) {
  return renderToStaticMarkup(
    <CapabilityMatrix matrix={resolveCapabilityMatrix(entitlement, rollout)} />,
  );
}

describe("CapabilityMatrix", () => {
  it("renders an accessible comparison table with a caption and row headers", () => {
    const html = render({ tier: "pro", state: "active" });

    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('aria-labelledby="capability-matrix-heading"');
  });

  it("keeps a wide table inside its own horizontal scroll container", () => {
    expect(render({ tier: "pro", state: "active" })).toContain("overflow-x-auto");
  });

  it("shows every capability with a screen-reader friendly availability marker", () => {
    const html = render({ tier: "pro", state: "active" });

    expect(html).toContain("Manuel katalog taraması");
    expect(html).toContain("Güvenli tekil SKU, fiyat ve stok düzeltmesi");
    expect(html).toContain("Toplu düzeltme");
    expect(html).toContain("Free pakete dahil değil");
    expect(html).toContain("PRO pakete dahil");
  });

  it("does not present an unaccepted capability as available", () => {
    const html = render({ tier: "pro", state: "active" });

    expect(html).toContain("Geliştirme mağazasıyla sınırlı");
    // The badge is text, never a button or a link the merchant could act on.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Düzeltmeyi başlat");
  });

  it("marks corrections as beta once the operator opens the production flags", () => {
    const html = render(
      { tier: "pro", state: "active" },
      signals({ productWritesEnabled: true, bulkWritesEnabled: true }),
    );

    expect(html).toContain("Beta");
    expect(html).not.toContain("Geliştirme mağazasıyla sınırlı");
  });

  it("tells a Free merchant which rows are PRO without claiming a price", () => {
    const html = render({ tier: "free", state: "active" });

    expect(html).toContain("PRO ile");
    expect(html).toContain("Mevcut planınız: Free.");
    expect(html).not.toContain("₺");
    expect(html).not.toContain("/ay");
    expect(html).toContain("fiyatı, para birimi, faturalama aralığı ve deneme süresi burada");
  });

  it("says so plainly when the licence could not be read", () => {
    const html = render({ tier: "pro", state: "unknown" });

    expect(html).toContain("Plan bilgisi şu anda doğrulanamadı");
    expect(html).toContain("Plan doğrulanamadı");
  });
});
