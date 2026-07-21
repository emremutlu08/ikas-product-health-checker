import { beforeEach, describe, expect, it, vi } from "vitest";
import { assessHealth } from "@/lib/health/health-model";
import { IkasAuthenticationError, IkasUpstreamError } from "@/lib/ikas/errors";
import { IkasTokenRefreshError, TokenStoreError } from "@/lib/ikas/token-store";
import { SnapshotStoreError } from "@/lib/scans/snapshot-store";
import { ScanBusyError } from "@/lib/scans/scan-service";
import type { HealthReport } from "@/lib/ikas/types";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  runManualScan: vi.fn(),
  getCanonicalAppOrigin: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/scans/scan-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scans/scan-service")>()),
  runManualScan: mocks.runManualScan,
}));

vi.mock("@/helpers/api-helpers", () => ({
  getCanonicalAppOrigin: mocks.getCanonicalAppOrigin,
}));

import { POST as postScan } from "./route";

const CANONICAL_ORIGIN = "https://health.example.com";

const installation = {
  authorizedAppId: "session-app",
  merchantId: "session-merchant",
  storeName: "session-store",
};

const report = {
  generatedAt: "2026-07-20T08:00:00.000Z",
  score: 82,
  productCount: 1,
  variantCount: 1,
  issueCount: 0,
  affectedProductCount: 0,
  scanStatus: "success",
  issueCountsByCode: {},
  criticalCount: 0,
  warningCount: 0,
  infoCount: 0,
  outOfStockBlockedCount: 0,
  ruleSummaries: [],
  productRows: [],
  issues: [],
} as unknown as HealthReport;

const snapshot = {
  version: 1 as const,
  scanId: "scan-1",
  authorizedAppId: installation.authorizedAppId,
  merchantId: installation.merchantId,
  generatedAt: "2026-07-20T08:00:00.000Z",
  report,
};

function scanRequest({
  origin = CANONICAL_ORIGIN,
  url = `${CANONICAL_ORIGIN}/api/scans`,
  headers = {},
  body,
}: {
  origin?: string | null;
  url?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
} = {}) {
  return new Request(url, {
    method: "POST",
    headers: { ...(origin === null ? {} : { origin }), ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ ...installation });
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.runManualScan.mockResolvedValue(snapshot);
  mocks.getCanonicalAppOrigin.mockReturnValue(CANONICAL_ORIGIN);
});

describe("POST /api/scans authentication and origin protection", () => {
  it("runs one scan for the session tenant and returns safe snapshot metadata", async () => {
    const response = await postScan(scanRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.runManualScan).toHaveBeenCalledOnce();
    expect(mocks.runManualScan).toHaveBeenCalledWith(installation);

    const body = await response.json();
    // The same normalized model the dashboard renders, not the legacy persisted score. Compared
    // against `assessHealth` itself rather than a copied literal, so this test cannot drift away
    // from the model the dashboard uses.
    const { score: _legacyScore, ...safeReport } = report;
    void _legacyScore;
    expect(body).toEqual({
      scanId: "scan-1",
      generatedAt: "2026-07-20T08:00:00.000Z",
      health: assessHealth(report),
      report: safeReport,
    });
    // Exactly one merchant-visible score: the un-normalized 82 must not survive anywhere.
    expect(body.report).not.toHaveProperty("score");
    expect(JSON.stringify(body)).not.toContain('"score":82');
    // Tenant identifiers must never travel back to the client.
    expect(JSON.stringify(body)).not.toContain("session-app");
    expect(JSON.stringify(body)).not.toContain("session-merchant");
  });

  it("returns 401 without scanning when the installation session is missing", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await postScan(scanRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "IKAS_LIVE_AUTH_REQUIRED" });
    expect(mocks.runManualScan).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a foreign origin", origin: "https://attacker.example.com" },
    { name: "a missing origin", origin: null },
    { name: "an origin that only prefixes the canonical one", origin: "https://health.example.com.evil.test" },
  ])("returns 403 without scanning for $name", async ({ origin }) => {
    const response = await postScan(scanRequest({ origin }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "IKAS_SCAN_ORIGIN_INVALID" });
    expect(mocks.runManualScan).not.toHaveBeenCalled();
  });

  it("checks the session before the origin so an anonymous caller never learns the origin rule", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await postScan(scanRequest({ origin: "https://attacker.example.com" }));

    expect(response.status).toBe(401);
    expect(mocks.runManualScan).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a query selector", url: `${CANONICAL_ORIGIN}/api/scans?authorizedAppId=attacker-app` },
    { name: "a merchant query selector", url: `${CANONICAL_ORIGIN}/api/scans?merchantId=attacker-merchant` },
  ])("ignores $name and scans only the session tenant", async ({ url }) => {
    const response = await postScan(scanRequest({ url }));

    expect(response.status).toBe(200);
    expect(mocks.runManualScan).toHaveBeenCalledWith(installation);
  });

  it.each([
    { name: "a JSON body", body: JSON.stringify({ authorizedAppId: "attacker-app" }), type: "application/json" },
    { name: "a form body", body: "authorizedAppId=attacker-app", type: "application/x-www-form-urlencoded" },
  ])("ignores tenant identifiers supplied in $name", async ({ body, type }) => {
    const response = await postScan(scanRequest({ body, headers: { "content-type": type } }));

    expect(response.status).toBe(200);
    expect(mocks.runManualScan).toHaveBeenCalledWith(installation);
  });

  it("ignores a spoofed tenant header", async () => {
    const response = await postScan(
      scanRequest({ headers: { "x-authorized-app-id": "attacker-app", "x-merchant-id": "attacker" } }),
    );

    expect(response.status).toBe(200);
    expect(mocks.runManualScan).toHaveBeenCalledWith(installation);
  });
});

describe("POST /api/scans failure mapping", () => {
  it("rejects a concurrent duplicate scan with a conflict rather than a second upstream run", async () => {
    mocks.runManualScan.mockRejectedValue(new ScanBusyError());

    const response = await postScan(scanRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "IKAS_SCAN_ALREADY_RUNNING" });
  });

  it.each([
    {
      name: "authentication failures",
      error: new IkasAuthenticationError("IKAS_LIVE_AUTH_REQUIRED"),
      status: 401,
      code: "IKAS_LIVE_AUTH_REQUIRED",
    },
    {
      name: "scan-limit failures",
      error: new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED"),
      status: 502,
      code: "IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED",
    },
    {
      name: "upstream GraphQL failures",
      error: new IkasUpstreamError("IKAS_UPSTREAM_GRAPHQL_ERROR"),
      status: 502,
      code: "IKAS_UPSTREAM_GRAPHQL_ERROR",
    },
    {
      name: "token backend failures",
      error: new TokenStoreError("backend", "get"),
      status: 503,
      code: "IKAS_TOKEN_BACKEND_UNAVAILABLE",
    },
    {
      name: "token refresh failures",
      error: new IkasTokenRefreshError("network"),
      status: 503,
      code: "IKAS_TOKEN_BACKEND_UNAVAILABLE",
    },
    {
      name: "snapshot backend failures",
      error: new SnapshotStoreError("backend", "put"),
      status: 503,
      code: "IKAS_SNAPSHOT_BACKEND_UNAVAILABLE",
    },
  ])("maps $name to a safe private error", async ({ error, status, code }) => {
    mocks.runManualScan.mockRejectedValue(error);

    const response = await postScan(scanRequest());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: code });
  });

  it("never leaks a raw upstream message for an unexpected failure", async () => {
    mocks.runManualScan.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.7:6379 upstream secret"));

    const response = await postScan(scanRequest());

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "IKAS_SCAN_FAILED" });
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("10.0.0.7");
  });

  it("fails closed when the canonical origin is misconfigured", async () => {
    mocks.getCanonicalAppOrigin.mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_DEPLOY_URL must be a valid canonical origin");
    });

    const response = await postScan(scanRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "IKAS_SCAN_FAILED" });
    expect(mocks.runManualScan).not.toHaveBeenCalled();
  });
});

describe("POST /api/scans browser form submissions", () => {
  it("redirects a form submission back to the dashboard instead of showing raw JSON", async () => {
    const response = await postScan(scanRequest({ headers: { accept: "text/html" } }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${CANONICAL_ORIGIN}/?scan=completed`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.runManualScan).toHaveBeenCalledOnce();
  });

  it("redirects with a truthful status when the installation is already scanning", async () => {
    mocks.runManualScan.mockRejectedValue(new ScanBusyError());

    const response = await postScan(scanRequest({ headers: { accept: "text/html" } }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${CANONICAL_ORIGIN}/?scan=busy`);
  });

  it("redirects with a distinct status when the catalog exceeds scan limits", async () => {
    mocks.runManualScan.mockRejectedValue(new IkasUpstreamError("IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED"));

    const response = await postScan(scanRequest({ headers: { accept: "text/html" } }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${CANONICAL_ORIGIN}/?scan=limit`);
  });

  it("redirects with a generic failure status for any other error", async () => {
    mocks.runManualScan.mockRejectedValue(new Error("boom"));

    const response = await postScan(scanRequest({ headers: { accept: "text/html" } }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${CANONICAL_ORIGIN}/?scan=failed`);
  });

  it("keeps a rejected form submission on the JSON error path when the session is missing", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await postScan(scanRequest({ headers: { accept: "text/html" } }));

    expect(response.status).toBe(401);
    expect(mocks.runManualScan).not.toHaveBeenCalled();
  });
});
