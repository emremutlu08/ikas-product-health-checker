import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/IkasAppBridgeReady", () => ({ IkasAppBridgeReady: () => null }));

import { AuthorizeStorePageContent } from "@/components/AuthorizeStorePageContent";

describe("authorize store page", () => {
  it("uses the same light product surface as setup", async () => {
    const element = await AuthorizeStorePageContent({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("bg-slate-50");
    expect(html).not.toContain("bg-slate-950");
  });
});