import { describe, expect, it } from "vitest";
import { isValidStoreName, normalizeStoreNameInput } from "./store-name";

describe("normalizeStoreNameInput", () => {
  it("keeps a plain store name", () => {
    expect(normalizeStoreNameInput("foo-store")).toBe("foo-store");
  });

  it("extracts store name from pasted myikas admin URLs", () => {
    expect(normalizeStoreNameInput("https://foo.myikas.com/admin")).toBe("foo");
    expect(normalizeStoreNameInput("foo.myikas.com/admin/products?x=1")).toBe("foo");
    expect(normalizeStoreNameInput("  HTTPS://Foo-Store.myikas.com/admin#apps  ")).toBe("foo-store");
  });

  it("validates normalized store names as subdomains", () => {
    expect(isValidStoreName("foo-store")).toBe(true);
    expect(isValidStoreName("foo_store")).toBe(false);
    expect(isValidStoreName("-foo")).toBe(false);
    expect(isValidStoreName("foo.myikas.com")).toBe(false);
  });
});
