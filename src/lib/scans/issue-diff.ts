import { createHash } from "node:crypto";
import type { HealthIssue } from "@/lib/ikas/types";

export type StableHealthIssue = {
  identity: string;
  issue: HealthIssue;
};

export type HealthIssueDiff = {
  baseline: "missing" | "available";
  /** Every issue in the current snapshot, independently of whether a baseline exists. */
  current: StableHealthIssue[];
  added: StableHealthIssue[];
  ongoing: StableHealthIssue[];
  resolved: StableHealthIssue[];
};

export type IssueDiffErrorCode = "duplicate_identity";
export type IssueDiffSource = "previous" | "current";

export class IssueDiffError extends Error {
  readonly code: IssueDiffErrorCode;
  readonly source: IssueDiffSource;

  constructor(code: IssueDiffErrorCode, source: IssueDiffSource) {
    super(`IKAS_ISSUE_DIFF_${code.toUpperCase()}_${source.toUpperCase()}`);
    this.name = "IssueDiffError";
    this.code = code;
    this.source = source;
  }
}

/**
 * Identity deliberately excludes translated/display data. A product rename, severity copy edit,
 * message change or value update must not turn one continuing problem into one resolved plus one
 * new problem.
 *
 * JSON tuple encoding keeps missing variants distinct and avoids delimiter ambiguity. The digest
 * makes the identity fixed-size and safe to use in URLs or indexes without exposing product ids.
 */
export function stableIssueIdentity(issue: HealthIssue): string {
  const tuple = JSON.stringify([issue.productId, issue.variantId ?? null, issue.code]);
  return `issue_v1_${createHash("sha256").update(tuple, "utf8").digest("base64url")}`;
}

function identifyUnique(issues: HealthIssue[], source: IssueDiffSource) {
  const identified = new Map<string, StableHealthIssue>();

  for (const issue of issues) {
    const identity = stableIssueIdentity(issue);
    if (identified.has(identity)) throw new IssueDiffError("duplicate_identity", source);
    identified.set(identity, { identity, issue });
  }

  return identified;
}

function sorted(entries: Iterable<StableHealthIssue>) {
  return [...entries].sort((left, right) => left.identity.localeCompare(right.identity));
}

/**
 * Compares two validated snapshot issue sets without IO.
 *
 * `undefined` is not equivalent to an empty previous report: it means no baseline exists, so all
 * change buckets stay empty rather than calling every first-scan issue a regression. Callers can
 * still render `current` while explaining that change tracking starts with the next scan.
 */
export function diffHealthIssues(
  previous: HealthIssue[] | undefined,
  current: HealthIssue[],
): HealthIssueDiff {
  const currentById = identifyUnique(current, "current");
  const currentEntries = sorted(currentById.values());

  if (previous === undefined) {
    return {
      baseline: "missing",
      current: currentEntries,
      added: [],
      ongoing: [],
      resolved: [],
    };
  }

  const previousById = identifyUnique(previous, "previous");
  const added: StableHealthIssue[] = [];
  const ongoing: StableHealthIssue[] = [];
  const resolved: StableHealthIssue[] = [];

  for (const [identity, entry] of currentById) {
    if (previousById.has(identity)) ongoing.push(entry);
    else added.push(entry);
  }

  for (const [identity, entry] of previousById) {
    if (!currentById.has(identity)) resolved.push(entry);
  }

  return {
    baseline: "available",
    current: currentEntries,
    added: sorted(added),
    ongoing: sorted(ongoing),
    resolved: sorted(resolved),
  };
}
