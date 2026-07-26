import { describe, expect, it } from "vitest";
import { canonicalIkasTimestamp } from "./timestamps";

describe("canonicalIkasTimestamp", () => {
  it("renders the epoch-milliseconds scalar and the ISO string identically", () => {
    const epochMs = 1_753_000_000_000;
    const iso = new Date(epochMs).toISOString();

    expect(canonicalIkasTimestamp(epochMs)).toBe(iso);
    expect(canonicalIkasTimestamp(iso)).toBe(iso);
    // The stale guard only works because both forms collapse onto one value.
    expect(canonicalIkasTimestamp(epochMs)).toBe(canonicalIkasTimestamp(iso));
  });

  it("returns nothing for a value that cannot anchor a stale guard", () => {
    for (const value of [null, undefined, "", "not-a-date", Number.NaN]) {
      expect(canonicalIkasTimestamp(value as never)).toBeUndefined();
    }
  });
});
