import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardHeader } from "./DashboardHeader";

const render = (props: Parameters<typeof DashboardHeader>[0]) =>
  renderToStaticMarkup(<DashboardHeader {...props} />);

const base = {
  storeName: "dev-emre2",
  generatedAt: "2026-07-18T08:00:00.000Z",
  stale: false,
  csvHref: "/api/report.csv",
  scanBusy: false,
};

describe("product and store identity", () => {
  it("names the product and the connected store", () => {
    const html = render(base);

    expect(html).toContain("Ürün Sağlığı");
    expect(html).toContain("dev-emre2");
  });

  it("omits the store row entirely when the session carries no store name", () => {
    const html = render({ ...base, storeName: undefined });

    expect(html).not.toContain("Mağaza:");
  });

  it("uses a header landmark so the region is reachable as a stable landmark", () => {
    expect(render(base)).toContain("<header");
  });
});

describe("plan state is only shown when it can be told truthfully", () => {
  /**
   * There is no server-side entitlement resolution on the dashboard read path yet, so the
   * header must not claim a plan. Guessing "Free" would be an unverified assertion about a
   * merchant's billing state, and a plan-management link would have to be invented.
   */
  it("does not assert a plan tier", () => {
    const html = render(base);

    for (const claim of ["Ücretsiz", "Free", "Pro", "Plan"]) {
      expect(html).not.toContain(claim);
    }
  });

  it("does not invent a plan-management destination", () => {
    const html = render(base);

    expect(html).not.toMatch(/href="[^"]*(plan|billing|subscription|upgrade)/i);
  });

  /**
   * The product decision, pinned so it is not re-opened by a reviewer asking for the missing
   * header field: plan state is shown only once a trustworthy entitlement value is available
   * from the server without a live call on every dashboard read. The header takes no plan prop
   * at all, so there is nothing here to fill in with a guess, and PR D — which wires cached
   * server-side entitlement — is where the field arrives.
   */
  it("accepts no plan input at all, so a plan can only appear with real entitlement wiring", () => {
    const withGuessedPlan = { ...base, plan: "Ücretsiz", planHref: "/billing" } as Parameters<
      typeof DashboardHeader
    >[0];

    const html = render(withGuessedPlan);

    expect(html).not.toContain("Ücretsiz");
    expect(html).not.toContain("/billing");
  });
});

describe("scan freshness", () => {
  it("shows the last successful scan as a machine-readable timestamp", () => {
    const html = render(base);

    expect(html).toContain("Son tarama");
    expect(html).toContain('dateTime="2026-07-18T08:00:00.000Z"');
  });

  it("marks a stale snapshot in words, not only in colour", () => {
    const html = render({ ...base, stale: true });

    expect(html).toContain("güncelliğini yitirmiş olabilir");
  });

  it("does not warn about staleness for a fresh snapshot", () => {
    expect(render(base)).not.toContain("güncelliğini yitirmiş olabilir");
  });

  it("says so plainly when no scan has ever succeeded", () => {
    const html = render({ ...base, generatedAt: undefined, csvHref: undefined });

    expect(html).toContain("Henüz tarama yapılmadı");
    expect(html).not.toContain("dateTime=");
  });
});

describe("the primary scan action", () => {
  it("posts to the scan endpoint as a form rather than navigating to it", () => {
    const html = render(base);

    expect(html).toContain('action="/api/scans"');
    expect(html).toContain('method="post"');
    expect(html).toContain("Şimdi tara");
    expect(html).not.toContain('href="/api/scans"');
  });

  it("submits nothing that identifies a tenant, so the server session decides", () => {
    const html = render(base);

    expect(html).not.toContain("<input");
  });

  it("blocks a duplicate submission while a scan is known to be running", () => {
    const html = render({ ...base, scanBusy: true });

    // The attribute, not the string: `disabled:` also appears as a Tailwind state variant.
    expect(html).toContain('disabled=""');
    expect(html).toContain("Tarama sürüyor");
    expect(html).not.toContain("Şimdi tara");
  });

  it("keeps the scan action enabled when no scan is running", () => {
    expect(render(base)).not.toContain('disabled=""');
  });
});

describe("secondary history and CSV access", () => {
  it("links to the explicit history boundary without asserting a plan", () => {
    const html = render(base);

    expect(html).toContain('href="/history"');
    expect(html).toContain("Geçmiş");
  });

  it("offers CSV as a secondary action beside the primary scan", () => {
    const html = render(base);

    expect(html).toContain('href="/api/report.csv"');
    expect(html).toContain("CSV indir");
  });

  it("hides CSV when there is no snapshot to export", () => {
    const html = render({ ...base, generatedAt: undefined, csvHref: undefined });

    expect(html).not.toContain("/api/report.csv");
    expect(html).not.toContain("CSV indir");
  });
});

describe("visual system", () => {
  it("uses semantic tokens rather than ad-hoc palette steps", () => {
    const html = render(base);

    expect(html).not.toMatch(/(slate|orange|violet|emerald|amber)-\d{2,3}/);
  });

  it("carries no prototype or internal language", () => {
    const html = render(base);

    for (const word of ["MVP", "ilk sürüm", "sinyal", "beta", "prototip"]) {
      expect(html).not.toContain(word);
    }
  });
});
