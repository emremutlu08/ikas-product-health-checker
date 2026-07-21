import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Loading from "./loading";
import NotFound from "./not-found";

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
