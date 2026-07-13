import { describe, expect, it } from "vitest";
import { getCanonicalAppOrigin, getRedirectUri } from "./api-helpers";

describe("canonical application origin", () => {
  it("uses the configured HTTPS origin and strips only a trailing slash", () => {
    expect(
      getCanonicalAppOrigin({
        deployUrl: "https://health.example.com/",
        environment: "production",
      }),
    ).toBe("https://health.example.com");
    expect(
      getRedirectUri({
        deployUrl: "https://health.example.com",
        environment: "production",
      }),
    ).toBe("https://health.example.com/api/oauth/callback/ikas");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("allows an explicit loopback HTTP origin outside production: %s", (deployUrl) => {
    expect(getCanonicalAppOrigin({ deployUrl, environment: "development" })).toBe(deployUrl);
  });

  it.each([
    "http://health.example.com",
    "http://localhost.evil.example",
    "ftp://health.example.com",
  ])("rejects a non-HTTPS non-loopback origin: %s", (deployUrl) => {
    expect(() => getCanonicalAppOrigin({ deployUrl, environment: "development" })).toThrow();
  });

  it("does not allow the development loopback exception in production", () => {
    expect(() =>
      getCanonicalAppOrigin({ deployUrl: "http://localhost:3000", environment: "production" }),
    ).toThrow();
  });

  it.each([
    "https://user@health.example.com",
    "https://user%40health.example.com",
    "https://health.example.com\\@attacker.example",
    "https://health.example.com%5c@attacker.example",
    "https://health.example.com/%0d%0aInjected",
    "https://%68ealth.example.com",
    "https://health.example.com/extra",
    "https://health.example.com?next=attacker",
    "https://health.example.com#fragment",
    " https://health.example.com",
  ])("rejects non-canonical or hostile configured origins: %s", (deployUrl) => {
    expect(() => getCanonicalAppOrigin({ deployUrl, environment: "production" })).toThrow();
  });
});
