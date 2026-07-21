import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/IkasAppBridgeReady", () => ({ IkasAppBridgeReady: () => null }));

import { AuthorizeStorePageContent } from "@/components/AuthorizeStorePageContent";

/**
 * `/authorize-store` is the first screen a merchant ever sees and the dashboard is the second,
 * so they have to read as one product. This surface is held to the same semantic token set as
 * the dashboard rather than the ad-hoc slate/orange palette it shipped with. Only the styling
 * is in scope: the OAuth action, the field contract and the failure copy are asserted
 * unchanged alongside it.
 */
const render = async (searchParams = {}) =>
  renderToStaticMarkup(
    await AuthorizeStorePageContent({ searchParams: Promise.resolve(searchParams) }),
  );

describe("authorize store page uses the shared design system", () => {
  it("paints the page on the semantic canvas token", async () => {
    const html = await render();

    expect(html).toContain("bg-canvas");
  });

  it("references no ad-hoc palette steps on the public authorization surface", async () => {
    const html = await render();

    expect(html).not.toMatch(/(slate|orange|violet|emerald|amber|red)-\d{2,3}/);
  });

  it("uses the shared surface, border and accent roles for the form itself", async () => {
    const html = await render();

    expect(html).toContain("bg-surface");
    expect(html).toContain("border-border");
    expect(html).toContain("bg-accent");
  });

  it("styles the authorization failure state with the critical status role", async () => {
    const html = await render({ status: "fail", reason: "invalid_store_name", errorId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });

    expect(html).toContain("border-critical");
    expect(html).not.toMatch(/red-\d{2,3}/);
  });
});

describe("authorization behaviour is unchanged by the restyle", () => {
  it("still posts the store name to the ikas OAuth entry point", async () => {
    const html = await render();

    expect(html).toContain('action="/api/oauth/authorize/ikas"');
    expect(html).toContain('name="storeName"');
    expect(html).toContain("ikas ile güvenli şekilde bağlan");
  });

  it("still explains the read-only scope and keeps the field help wired up", async () => {
    const html = await render();

    expect(html).toContain("Ürün veya stok bilgileri değiştirilmez");
    expect(html).toContain('id="storeName-help"');
    expect(html).toContain('aria-describedby="storeName-help"');
  });

  it("still surfaces a failure reason and its support code", async () => {
    const html = await render({ status: "fail", reason: "invalid_store_name", errorId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });

    expect(html).toContain('role="alert"');
    expect(html).toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(html).toContain('aria-describedby="storeName-help authorization-error"');
  });
});
