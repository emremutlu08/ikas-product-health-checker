import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CorrectionPanel, type CorrectableTarget } from "./CorrectionPanel";
import {
  CORRECTION_ERROR_MESSAGES,
  correctionErrorMessage,
  UNKNOWN_CORRECTION_MESSAGE,
} from "@/lib/mutations/correction-messages";

const target: CorrectableTarget = {
  productId: "product-1",
  productName: "Classic Laptop Sleeve",
  variantId: "variant-1",
  variantLabel: "Siyah",
  kind: "sku_change",
  issueMessage: "Aktif varyantta SKU eksik.",
  currentValue: "",
  imageLabel: "CL",
};

describe("CorrectionPanel", () => {
  it("labels its input and shows the current value before anything is typed", () => {
    const html = renderToStaticMarkup(<CorrectionPanel targets={[target]} />);

    expect(html).toContain('for="correction-variant-1-sku_change"');
    expect(html).toContain('id="correction-variant-1-sku_change"');
    expect(html).toContain("Yeni SKU");
    expect(html).toContain("Mevcut değer: — (boş)");
  });

  it("promises on screen that a preview changes nothing", () => {
    const html = renderToStaticMarkup(<CorrectionPanel targets={[target]} />);

    expect(html).toContain("Önizleme hiçbir şey değiştirmez");
    expect(html).toContain("açık onayınızdan sonra uygulanır");
  });

  it("renders no confirmation dialog until a preview exists", () => {
    const html = renderToStaticMarkup(<CorrectionPanel targets={[target]} />);

    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Onayla ve uygula");
  });

  it("says so plainly when the scan found nothing correctable", () => {
    expect(renderToStaticMarkup(<CorrectionPanel targets={[]} />)).toContain(
      "düzeltilebilir bir sorun bulunmadı",
    );
  });

  it("gives each correction kind its own field label", () => {
    const html = renderToStaticMarkup(
      <CorrectionPanel
        targets={[
          target,
          { ...target, variantId: "variant-2", kind: "price_change", currentValue: "199.9" },
          { ...target, variantId: "variant-3", kind: "stock_change", currentValue: "0" },
        ]}
      />,
    );

    expect(html).toContain("Yeni SKU");
    expect(html).toContain("Yeni satış fiyatı");
    expect(html).toContain("Yeni stok adedi");
  });
});

describe("correctionErrorMessage", () => {
  it("has Turkish copy for every code the correction routes can return", () => {
    for (const [code, message] of Object.entries(CORRECTION_ERROR_MESSAGES)) {
      expect(correctionErrorMessage(code), code).toBe(message);
      expect(message.length, code).toBeGreaterThan(10);
    }
  });

  it("never claims success for an outcome it does not recognise", () => {
    for (const unknown of [undefined, null, 42, "IKAS_SOMETHING_NEW"]) {
      expect(correctionErrorMessage(unknown)).toBe(UNKNOWN_CORRECTION_MESSAGE);
    }
    expect(UNKNOWN_CORRECTION_MESSAGE).toContain("doğrulanamadı");
    expect(UNKNOWN_CORRECTION_MESSAGE).toContain("tekrar çalıştırmayın");
  });

  it("tells the merchant nothing was written for every provably-untouched outcome", () => {
    for (const code of [
      "IKAS_CORRECTION_STALE_PRODUCT",
      "IKAS_CORRECTION_STALE_VALUE",
      "IKAS_CORRECTION_PREFLIGHT_FAILED",
    ]) {
      expect(CORRECTION_ERROR_MESSAGES[code]).toContain("yazılmadı");
    }
    expect(CORRECTION_ERROR_MESSAGES.IKAS_CORRECTION_WRITE_REJECTED).toContain("değişiklik olmadı");
  });

  it("warns rather than reassures when the outcome is unverified", () => {
    for (const code of [
      "IKAS_CORRECTION_MUTATION_OUTCOME_UNKNOWN",
      "IKAS_CORRECTION_VERIFICATION_FAILED",
      "IKAS_CORRECTION_INVARIANT_VIOLATION",
    ]) {
      expect(CORRECTION_ERROR_MESSAGES[code]).toContain("kontrol edin");
    }
  });
});

/**
 * A scan can produce hundreds of correctable variants. Without a filter the merchant scrolls to
 * find the one product they came for, and the count line is what tells them the filter is doing
 * something rather than silently hiding rows.
 */
describe("CorrectionPanel search", () => {
  it("offers a labelled search field and states how much is on screen", () => {
    const html = renderToStaticMarkup(<CorrectionPanel targets={[target]} />);

    expect(html).toContain("Ürün ara");
    expect(html).toContain("1 düzeltme gösteriliyor.");
    expect(html).toContain('type="search"');
  });

  it("shows the product image beside each correction", () => {
    const withImage: CorrectableTarget = {
      ...target,
      imageSrc: "https://cdn.example.test/sleeve.webp",
    };

    const html = renderToStaticMarkup(<CorrectionPanel targets={[withImage]} />);

    expect(html).toContain("https://cdn.example.test/sleeve.webp");
  });

  it("falls back to initials rather than an empty tile when there is no image", () => {
    const html = renderToStaticMarkup(<CorrectionPanel targets={[target]} />);

    expect(html).toContain("CL");
    expect(html).not.toContain("<img");
  });
});
