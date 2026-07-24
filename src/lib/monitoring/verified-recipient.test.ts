import { describe, expect, it } from "vitest";
import {
  VerifiedRecipientConfigurationError,
  resolveVerifiedRecipient,
} from "./verified-recipient";

const tenant = { authorizedAppId: "app-1", merchantId: "merchant-1" };

function envWith(value: unknown) {
  return { IKAS_VERIFIED_EMAIL_RECIPIENTS_JSON: JSON.stringify(value) };
}

describe("resolveVerifiedRecipient", () => {
  it("returns only an exact, explicitly verified tenant match", () => {
    const env = envWith([
      { authorizedAppId: "app-1", merchantId: "merchant-1", email: "owner@example.com", verified: true },
      { authorizedAppId: "app-1", merchantId: "merchant-2", email: "other@example.com", verified: true },
    ]);

    expect(resolveVerifiedRecipient(tenant, env)).toEqual({ email: "owner@example.com" });
    expect(resolveVerifiedRecipient({ ...tenant, merchantId: "merchant-9" }, env)).toBeUndefined();
  });

  it.each([
    "not json",
    JSON.stringify({}),
    JSON.stringify([{ authorizedAppId: "app-1", merchantId: "merchant-1", email: "owner@example.com", verified: false }]),
    JSON.stringify([{ authorizedAppId: "app-1", merchantId: "merchant-1", email: "not-an-email", verified: true }]),
    JSON.stringify([
      { authorizedAppId: "app-1", merchantId: "merchant-1", email: "one@example.com", verified: true },
      { authorizedAppId: "app-1", merchantId: "merchant-1", email: "two@example.com", verified: true },
    ]),
  ])("rejects malformed or ambiguous server configuration", (value) => {
    expect(() => resolveVerifiedRecipient(tenant, { IKAS_VERIFIED_EMAIL_RECIPIENTS_JSON: value })).toThrow(
      VerifiedRecipientConfigurationError,
    );
  });

  it("returns undefined when no recipient source is configured", () => {
    expect(resolveVerifiedRecipient(tenant, {})).toBeUndefined();
  });
});
