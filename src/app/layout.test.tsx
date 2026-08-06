import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("application metadata", () => {
  it("uses a merchant-facing product description", () => {
    // It read "salt okunur" until corrections shipped, and stayed that way for a day after the
    // write flags opened. The description a merchant reads in search results has to survive the
    // app gaining an ability, so this pins the standing promise — consent — not the old absolute.
    expect(metadata.description).toContain("onaylarsanız");
    expect(metadata.description).not.toContain("salt okunur");
    expect(metadata.description).not.toContain("MVP");
  });
});