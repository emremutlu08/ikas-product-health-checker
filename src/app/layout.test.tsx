import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("application metadata", () => {
  it("uses a merchant-facing product description", () => {
    expect(metadata.description).toContain("salt okunur");
    expect(metadata.description).not.toContain("MVP");
  });
});