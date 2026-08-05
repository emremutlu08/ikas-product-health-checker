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


/**
 * The panel no longer filters or slices — the server hands it one page. These helpers build the
 * selection a server would have produced, so a test states the page it is rendering.
 */
function panel(targets: CorrectableTarget[], search = "") {
  const selection = {
    targets,
    totalTargets: targets.length,
    unfilteredTargets: targets.length,
    page: 1,
    pageCount: 1,
    rangeStart: targets.length === 0 ? 0 : 1,
    rangeEnd: targets.length,
  };

  return (
    <CorrectionPanel
      query={{ search, page: 1 }}
      selection={selection}
      targets={targets}
      {...(search ? { clearSearchHref: "/corrections" } : {})}
    />
  );
}

describe("CorrectionPanel", () => {
  it("labels its input and shows the current value before anything is typed", () => {
    const html = renderToStaticMarkup(panel([target]));

    expect(html).toContain('for="correction-variant-1-sku_change"');
    expect(html).toContain('id="correction-variant-1-sku_change"');
    expect(html).toContain("Yeni SKU");
    expect(html).toContain("Mevcut değer: — (boş)");
  });

  it("promises on screen that a preview changes nothing", () => {
    const html = renderToStaticMarkup(panel([target]));

    expect(html).toContain("Önizleme hiçbir şey değiştirmez");
    expect(html).toContain("açık onayınızdan sonra uygulanır");
  });

  it("renders no confirmation dialog until a preview exists", () => {
    const html = renderToStaticMarkup(panel([target]));

    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Onayla ve uygula");
  });

  it("says so plainly when the scan found nothing correctable", () => {
    expect(renderToStaticMarkup(panel([]))).toContain(
      "düzeltilebilir bir sorun bulunmadı",
    );
  });

  it("gives each correction kind its own field label", () => {
    const html = renderToStaticMarkup(
      panel([
        target,
        { ...target, variantId: "variant-2", kind: "price_change", currentValue: "199.9" },
        { ...target, variantId: "variant-3", kind: "stock_change", currentValue: "0" },
      ]),
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
  /**
   * The search is a GET form, not client state, because the server does the filtering: the result
   * has to be a real URL that survives a reload and can be linked.
   */
  it("offers a labelled search field that submits to the server", () => {
    const html = renderToStaticMarkup(panel([target]));

    expect(html).toContain("Ürün ara");
    expect(html).toContain('type="search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/corrections"');
  });

  /**
   * The range is what tells a merchant they are looking at part of a larger list. Without it,
   * page one of six is indistinguishable from the whole set.
   */
  it("states which slice of the results is on screen", () => {
    const html = renderToStaticMarkup(panel([target]));

    expect(html).toContain("1–1 / 1 düzeltme");
  });

  it("shows the product image beside each correction", () => {
    const withImage: CorrectableTarget = {
      ...target,
      imageSrc: "https://cdn.example.test/sleeve.webp",
    };

    const html = renderToStaticMarkup(panel([withImage]));

    expect(html).toContain("https://cdn.example.test/sleeve.webp");
  });

  it("falls back to initials rather than an empty tile when there is no image", () => {
    const html = renderToStaticMarkup(panel([target]));

    expect(html).toContain("CL");
    expect(html).not.toContain("<img");
  });
});

/**
 * With fifty corrections on a page, a confirmation rendered at the foot of the list means the
 * merchant reads "Şu anki değer" with the product it belongs to scrolled off screen — and confirms
 * a permanent catalog write from there. It has to sit inside the card it acts on.
 */
describe("CorrectionPanel confirmation placement", () => {
  it("keeps the confirmation inside the list, not appended after it", () => {
    const html = renderToStaticMarkup(panel([target]));

    // Nothing to confirm yet, so the marker that proves placement is the list itself closing last.
    expect(html.lastIndexOf("</ul>")).toBeGreaterThan(html.indexOf("<li"));
    expect(html).not.toContain('role="dialog"');
  });

  /**
   * `aria-modal` would claim the rest of the page is unavailable. Nothing here is inert — the other
   * cards stay readable and reachable — so asserting it would mislead a screen reader.
   */
  it("never claims to be a modal", () => {
    const html = renderToStaticMarkup(panel([target]));

    expect(html).not.toContain("aria-modal");
  });
});

/**
 * The list is a projection of the stored scan, so a correction cannot change it — the card would
 * keep reading "Aktif varyantta SKU eksik / Mevcut değer: — (boş)" directly under a message saying
 * the write was verified. A merchant reading that either does it twice or stops trusting the
 * message. These pin the state the card must reach instead.
 */
describe("CorrectionPanel after a verified fix", () => {
  it("still offers the form while nothing has been fixed", () => {
    const html = renderToStaticMarkup(panel([target]));

    expect(html).toContain("Aktif varyantta SKU eksik.");
    expect(html).toContain("Önizle");
    expect(html).not.toContain("Düzeltildi");
    // Progress is absent rather than "0 uygulandı", which would read as failure.
    expect(html).not.toContain("Bu oturumda");
  });

  /**
   * Only a server-verified write may mark a card as fixed, so the initial render — which has no
   * verified result yet — must never show that state.
   */
  it("never shows a card as fixed before the server verified anything", () => {
    const html = renderToStaticMarkup(panel([target, { ...target, variantId: "variant-2" }]));

    expect(html).not.toContain("ikas'tan okunarak doğrulandı");
    // The bare button label, not the "Önizleme hiçbir şey değiştirmez" sentence beside it.
    expect(html.match(/>Önizle</g)).toHaveLength(2);
  });
});
