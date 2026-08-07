import { describe, expect, it } from "vitest";
import { MAX_BULK_ITEMS } from "./bulk-batch-store";
import {
  BULK_ERROR_MESSAGES,
  BULK_SELECTION_LIMIT,
  bulkErrorMessage,
  bulkItemReasonMessage,
  CORRECTION_ERROR_MESSAGES,
  UNKNOWN_BULK_MESSAGE,
  UNKNOWN_CORRECTION_MESSAGE,
} from "./correction-messages";

/**
 * The copy table is the merchant's only account of what happened to their catalog, so a code with
 * no wording is not a cosmetic gap — it renders as "we could not verify this", which sends someone
 * to check a product that is in fact fine.
 */
describe("bulk correction copy", () => {
  /**
   * The panel tells merchants how many corrections fit in one batch. It cannot import the real
   * limit, because that constant lives beside the Redis batch store and would drag it into the
   * browser bundle, so it keeps its own copy — and this is what stops the two drifting apart.
   */
  it("advertises the same batch size the server actually enforces", () => {
    expect(BULK_SELECTION_LIMIT).toBe(MAX_BULK_ITEMS);
    expect(BULK_ERROR_MESSAGES.IKAS_BULK_TOO_MANY_ITEMS).toContain(String(MAX_BULK_ITEMS));
  });

  /**
   * Mirrors `BULK_ERROR_STATUS` in the bulk route: every failure that endpoint can name has to
   * arrive on screen as something a merchant can act on.
   */
  it.each([
    "invalid_request",
    "too_many_items",
    "duplicate_target",
    "batch_missing",
    "batch_expired",
    "batch_replay",
    "batch_cancelled",
    "plan_mismatch",
    "no_ready_items",
    "write_disabled",
    "feature_required",
  ])("has merchant-facing wording for a batch that fails with %s", (code) => {
    const message = bulkErrorMessage(`IKAS_BULK_${code.toUpperCase()}`);

    expect(message).not.toBe(UNKNOWN_BULK_MESSAGE);
    expect(message.length).toBeGreaterThan(10);
  });

  /**
   * A batch can also fail for the reasons a single correction fails for. Those already have
   * wording, and reusing it is what keeps one vocabulary on screen rather than two that describe
   * the same condition differently.
   */
  it("falls through to the single-correction wording for a shared failure", () => {
    expect(bulkErrorMessage("IKAS_LIVE_AUTH_REQUIRED")).toBe(
      CORRECTION_ERROR_MESSAGES.IKAS_LIVE_AUTH_REQUIRED,
    );
  });

  it("admits it does not know rather than inventing a reason", () => {
    expect(bulkErrorMessage("IKAS_BULK_SOMETHING_NEW")).toBe(UNKNOWN_BULK_MESSAGE);
    expect(bulkErrorMessage(undefined)).toBe(UNKNOWN_BULK_MESSAGE);
  });

  /**
   * Per-item reasons arrive unprefixed from the planning and execution services. Every state those
   * services can produce is listed here, because an unmapped one would tell the merchant their
   * correction's outcome is unverified when the server knew exactly why it was refused.
   */
  it.each([
    "invalid_request",
    "no_change",
    "snapshot_required",
    "snapshot_stale",
    "issue_not_found",
    "product_missing",
    "variant_missing",
    "price_row_missing",
    "price_row_ambiguous",
    "stock_location_missing",
    "stock_location_ambiguous",
    "stale_guard_unavailable",
    "operation_conflict",
    "unavailable",
    "stale_product",
    "stale_value",
    "write_rejected",
    "rate_limited",
    "confirmation_replay",
    "confirmation_expired",
    "verification_failed",
    "invariant_violation",
    "origin_not_allowed",
  ])("explains a per-item outcome of %s", (reason) => {
    expect(bulkItemReasonMessage(reason)).not.toBe(UNKNOWN_CORRECTION_MESSAGE);
  });

  /**
   * The one exception, stated rather than left to look like an oversight: an unknown mutation
   * outcome genuinely has no better wording than "check your catalog", so it resolves to exactly
   * the fallback and that is correct.
   */
  it("keeps the check-your-catalog wording for an outcome nobody can verify", () => {
    expect(bulkItemReasonMessage("mutation_outcome_unknown")).toBe(UNKNOWN_CORRECTION_MESSAGE);
    expect(bulkItemReasonMessage("")).toBe(UNKNOWN_CORRECTION_MESSAGE);
  });
});
