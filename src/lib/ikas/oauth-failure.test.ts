import { describe, expect, it } from "vitest";
import {
  normalizeOAuthSupportId,
  OAUTH_FAILURE_MESSAGES,
  OAUTH_FAILURE_REASONS,
  parseOAuthFailureReason,
} from "./oauth-failure";

describe("OAuth failure presentation", () => {
  it("maps only allowlisted reason codes", () => {
    expect(parseOAuthFailureReason("token_persist_failed")).toBe("token_persist_failed");
    expect(parseOAuthFailureReason("raw provider error: secret")).toBe("unexpected_error");
  });

  it("provides an actionable Turkish message for every safe reason", () => {
    for (const reason of OAUTH_FAILURE_REASONS) {
      const message = OAUTH_FAILURE_MESSAGES[reason];
      expect(message.title.length).toBeGreaterThan(5);
      expect(message.detail.length).toBeGreaterThan(5);
      expect(message.action.length).toBeGreaterThan(5);
    }
  });

  it("renders only server-generated UUID support IDs", () => {
    expect(normalizeOAuthSupportId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(normalizeOAuthSupportId("<script>alert(1)</script>")).toBe("");
  });
});
