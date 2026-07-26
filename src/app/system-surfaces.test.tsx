import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ErrorBoundary from "./error";
import Loading from "./loading";
import NotFound from "./not-found";
import { metadata } from "./layout";
import { APP_BRAND, APP_FULL_NAME, APP_NAME, APP_SECTION_NAME } from "@/globals/branding";

/**
 * The surfaces Next renders on its own — the loading fallback and the 404 — are as
 * merchant-visible as the dashboard, and a merchant who hits one mid-navigation sees it in the
 * same iframe. They shipped in the old slate/orange palette with a much larger radius, which
 * made every transition look like a jump between two products. They are held to the same
 * semantic tokens here.
 */
const surfaces = [
  { name: "loading fallback", render: () => renderToStaticMarkup(<Loading />) },
  { name: "not-found page", render: () => renderToStaticMarkup(<NotFound />) },
];

describe.each(surfaces)("$name uses the shared design system", ({ render }) => {
  it("references no ad-hoc palette steps", () => {
    expect(render()).not.toMatch(/(slate|orange|violet|emerald|amber)-\d{2,3}/);
  });

  it("paints on the semantic canvas and surface tokens", () => {
    const html = render();

    expect(html).toContain("bg-canvas");
    expect(html).toContain("bg-surface");
  });

  it("carries the product name so the merchant knows where they are", () => {
    expect(render()).toContain("Ürün Sağlığı");
  });
});

describe("the loading fallback stays announceable", () => {
  it("keeps its polite live region so the wait is announced, not just drawn", () => {
    const html = renderToStaticMarkup(<Loading />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});

describe("the not-found page keeps its way back", () => {
  it("offers a single route home", () => {
    const html = renderToStaticMarkup(<NotFound />);

    expect(html).toContain('href="/"');
    expect(html).toContain("Sayfa bulunamadı");
  });
});

/**
 * The name a merchant arrives to.
 *
 * These assertions pin the whole brand string rather than a substring, because the previous
 * spelling was a substring of the new one — every existing test kept passing through a rename that
 * changed what the product is called. A rename should have to update this file on purpose.
 */
describe("app identity", () => {
  it("names the app in full on every surface a merchant can arrive at cold", () => {
    for (const { render } of surfaces) {
      expect(render()).toContain(APP_FULL_NAME);
    }
    expect(renderToStaticMarkup(<ErrorBoundary error={new Error("x")} reset={() => {}} unstable_retry={() => {}} />))
      .toContain(APP_FULL_NAME);
  });

  it("uses the full name for the browser tab", () => {
    expect(metadata.title).toBe(APP_FULL_NAME);
  });

  it("keeps navigation on the short section name, which reads as a destination", () => {
    expect(APP_SECTION_NAME).toBe("Ürün Sağlığı");
    expect(APP_FULL_NAME.startsWith(`${APP_BRAND} | `)).toBe(true);
    // The brand belongs in front of the app name, not inside it.
    expect(APP_NAME).not.toContain(APP_BRAND);
  });
});
