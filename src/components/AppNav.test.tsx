import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppNav, APP_NAV_ITEMS } from "./AppNav";

describe("AppNav", () => {
  /**
   * The five hand-written navigations this replaces each offered a different subset, which is how
   * `/corrections` ended up reachable only from the dashboard. Every page must offer every
   * destination or the drift starts again.
   */
  it("offers every destination from every page", () => {
    for (const item of APP_NAV_ITEMS) {
      const html = renderToStaticMarkup(<AppNav current={item.href} />);

      for (const other of APP_NAV_ITEMS) {
        expect(html, `${item.href} → ${other.href}`).toContain(`href="${other.href}"`);
      }
    }
  });

  it("keeps one order everywhere, so the menu is learnable", () => {
    const html = renderToStaticMarkup(<AppNav current="/history" />);
    const positions = APP_NAV_ITEMS.map((item) => html.indexOf(`>${item.label}<`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /**
   * Marked for a screen reader *and* visibly. The previous navigation set `aria-current` while
   * giving the active link the same classes as every other, so sighted merchants saw five
   * identical pills and could not tell where they were.
   */
  it("marks the current page for screen readers and for the eye", () => {
    const html = renderToStaticMarkup(<AppNav current="/settings" />);

    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);

    const current = html.slice(html.indexOf('href="/settings"') - 400, html.indexOf('href="/settings"'));
    expect(current).toContain("border-accent");
    expect(current).toContain("font-semibold");
  });

  it("never marks a page the merchant is not on", () => {
    const html = renderToStaticMarkup(<AppNav current="/" />);
    const plan = html.slice(html.indexOf('href="/plan"') - 400, html.indexOf('href="/plan"'));

    expect(plan).not.toContain("border-accent");
  });
});
