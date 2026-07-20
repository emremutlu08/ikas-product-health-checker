export class IkasAuthenticationError extends Error {
  constructor(readonly code: "IKAS_LIVE_AUTH_REQUIRED" | "IKAS_AUTHENTICATION_FAILED") {
    super(code);
    this.name = "IkasAuthenticationError";
  }
}

export class IkasUpstreamError extends Error {
  constructor(
    readonly code:
      | "IKAS_UPSTREAM_HTTP_ERROR"
      | "IKAS_UPSTREAM_GRAPHQL_ERROR"
      | "IKAS_UPSTREAM_INVALID_RESPONSE"
      | "IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED",
  ) {
    super(code);
    this.name = "IkasUpstreamError";
  }
}
