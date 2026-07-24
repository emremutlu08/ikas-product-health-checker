import { describe, expect, it } from "vitest";
import type { HealthIssue } from "@/lib/ikas/types";
import {
  IssueDiffError,
  diffHealthIssues,
  stableIssueIdentity,
} from "./issue-diff";

function issue(overrides: Partial<HealthIssue> = {}): HealthIssue {
  return {
    code: "missing_sku",
    severity: "critical",
    productId: "product-1",
    productName: "Kazak",
    variantId: "variant-1",
    variantLabel: "M / Siyah",
    message: "Aktif varyantta SKU eksik.",
    ...overrides,
  };
}

describe("stableIssueIdentity", () => {
  it("ignores mutable display fields", () => {
    const before = issue();
    const after = issue({
      productName: "Yeni ürün adı",
      variantLabel: "Yeni varyant etiketi",
      message: "Yeni açıklama",
      severity: "warning",
      value: "değişti",
      productUpdatedAt: "2026-07-21T20:00:00.000Z",
    });

    expect(stableIssueIdentity(after)).toBe(stableIssueIdentity(before));
  });

  it("distinguishes the product, optional variant and issue code without delimiter collisions", () => {
    const identities = new Set([
      stableIssueIdentity(issue()),
      stableIssueIdentity(issue({ productId: "product-2" })),
      stableIssueIdentity(issue({ variantId: "variant-2" })),
      stableIssueIdentity(issue({ variantId: undefined })),
      stableIssueIdentity(issue({ code: "missing_barcode" })),
      stableIssueIdentity(issue({ productId: "a|b", variantId: "c" })),
      stableIssueIdentity(issue({ productId: "a", variantId: "b|c" })),
    ]);

    expect(identities).toHaveLength(7);
  });
});

describe("diffHealthIssues", () => {
  it("returns no change classification when there is no previous snapshot", () => {
    const current = [issue()];

    expect(diffHealthIssues(undefined, current)).toEqual({
      baseline: "missing",
      current: [{ identity: stableIssueIdentity(current[0]!), issue: current[0] }],
      added: [],
      ongoing: [],
      resolved: [],
    });
  });

  it("classifies added, ongoing and resolved issues from an available baseline", () => {
    const ongoingBefore = issue();
    const ongoingNow = issue({ productName: "Kazak (yenilendi)", message: "Yeni mesaj" });
    const resolved = issue({ productId: "product-resolved", variantId: undefined });
    const added = issue({ productId: "product-added", code: "missing_image", variantId: undefined });

    const result = diffHealthIssues([ongoingBefore, resolved], [added, ongoingNow]);

    expect(result.baseline).toBe("available");
    expect(result.added).toEqual([
      { identity: stableIssueIdentity(added), issue: added },
    ]);
    expect(result.ongoing).toEqual([
      { identity: stableIssueIdentity(ongoingNow), issue: ongoingNow },
    ]);
    expect(result.resolved).toEqual([
      { identity: stableIssueIdentity(resolved), issue: resolved },
    ]);
  });

  it("treats an explicitly empty previous snapshot as a real baseline", () => {
    const current = issue();
    const result = diffHealthIssues([], [current]);

    expect(result.baseline).toBe("available");
    expect(result.added.map((entry) => entry.issue)).toEqual([current]);
  });

  it("sorts every output by stable identity regardless of report order", () => {
    const a = issue({ productId: "a" });
    const b = issue({ productId: "b" });
    const c = issue({ productId: "c" });
    const result = diffHealthIssues([c, b], [b, a]);

    for (const entries of [result.current, result.added, result.ongoing, result.resolved]) {
      expect(entries.map((entry) => entry.identity)).toEqual(
        entries.map((entry) => entry.identity).toSorted(),
      );
    }
  });

  it("fails closed when either snapshot contains duplicate stable identities", () => {
    const duplicate = issue();

    expect(() => diffHealthIssues([duplicate, { ...duplicate }], [])).toThrowError(
      new IssueDiffError("duplicate_identity", "previous"),
    );
    expect(() => diffHealthIssues([], [duplicate, { ...duplicate }])).toThrowError(
      new IssueDiffError("duplicate_identity", "current"),
    );
  });
});
