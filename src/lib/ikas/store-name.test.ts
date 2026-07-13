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

  it.each([
    "attacker.example\\token",
    "user@attacker",
    "user%40attacker",
    "attacker%5ctoken",
    "foo\u0000bar",
    "foo\rbar",
    "foo\nbar",
    "foo\tbar",
    "foo\u007fbar",
    "foo\u0085bar",
  ])("rejects URL parser and control-character payload %j", (value) => {
    expect(isValidStoreName(value)).toBe(false);
  });

  it("rejects URLSearchParams-decoded hostile encodings", () => {
    const params = new URLSearchParams(
      "backslash=attacker.example%5Ctoken&userinfo=user%40attacker&control=foo%00bar",
    );

    expect(isValidStoreName(params.get("backslash")!)).toBe(false);
    expect(isValidStoreName(params.get("userinfo")!)).toBe(false);
    expect(isValidStoreName(params.get("control")!)).toBe(false);
  });
});
