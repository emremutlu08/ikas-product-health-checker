import { beforeEach, describe, expect, it, vi } from "vitest";
import { IkasUpstreamError } from "@/lib/ikas/errors";
import { IkasTokenRefreshError, TokenStoreError } from "@/lib/ikas/token-store";
import { SnapshotStoreError } from "@/lib/scans/snapshot-store";
import type { HealthReport } from "@/lib/ikas/types";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  getLatestProductHealthReport: vi.fn(),
  getProductHealthReportCsv: vi.fn(),
  collectProductHealthReport: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/ikas/report-service", () => ({
  getLatestProductHealthReport: mocks.getLatestProductHealthReport,
  getProductHealthReportCsv: mocks.getProductHealthReportCsv,
  collectProductHealthReport: mocks.collectProductHealthReport,
}));

import { GET as getJsonReport } from "./route";
import { GET as getCsvReport } from "../report.csv/route";

const installation = {
  authorizedAppId: "session-app",
  merchantId: "session-merchant",
  storeName: "session-store",
};

/**
 * `score` here is the legacy value a stored snapshot still carries. The counts beside it are
 * what the published health model is actually derived from, so the two deliberately disagree:
 * that disagreement is the thing these tests exist to pin down.
 */
const report = {
  score: 82,
  productCount: 31,
  affectedProductCount: 2,
  criticalCount: 4,
  warningCount: 0,
  infoCount: 0,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ ...installation });
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.getLatestProductHealthReport.mockResolvedValue({ source: "snapshot", snapshot });
  mocks.getProductHealthReportCsv.mockResolvedValue("product,issue\n");
});

describe("tenant-bound report routes read the stored snapshot", () => {
  it("ignores a hostile query selector and uses only the validated installation session", async () => {
    const response = await getJsonReport(
      new Request("https://health.example.com/api/report?authorizedAppId=attacker-app"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getLatestProductHealthReport).toHaveBeenCalledOnce();
    expect(mocks.getLatestProductHealthReport).toHaveBeenCalledWith(installation);
  });

  it("returns safe snapshot metadata without tenant identifiers and without scanning", async () => {
    const response = await getJsonReport(new Request("https://health.example.com/api/report"));

    const body = await response.json();
    expect(body.scanId).toBe("scan-1");
    expect(body.generatedAt).toBe("2026-07-20T08:00:00.000Z");
    expect(JSON.stringify(body)).not.toContain("session-app");
    expect(JSON.stringify(body)).not.toContain("session-merchant");
    expect(mocks.collectProductHealthReport).not.toHaveBeenCalled();
  });

  /**
   * A merchant reading the JSON report and a merchant reading the dashboard are looking at one
   * scan and must see one health number. The dashboard renders `assessHealth(report)`; this
   * route published the snapshot's legacy `score` instead, so the same snapshot showed 95 on
   * screen and 82 over the API.
   */
  it("publishes the same normalized health model the dashboard renders", async () => {
    const response = await getJsonReport(new Request("https://health.example.com/api/report"));

    const body = await response.json();
    // 4 critical issues x weight 7, over 31 products, against the 20-point ceiling.
    expect(body.health).toMatchObject({ score: 95, state: "good", productCount: 31 });
  });

  it("leaves no second, contradicting score on the merchant-visible response", async () => {
    const response = await getJsonReport(new Request("https://health.example.com/api/report"));

    const body = await response.json();
    expect(body.report).not.toHaveProperty("score");
    expect(JSON.stringify(body)).not.toContain('"score":82');
  });

  it("publishes a null score for a store with no products rather than a flattering number", async () => {
    mocks.getLatestProductHealthReport.mockResolvedValue({
      source: "snapshot",
      snapshot: {
        ...snapshot,
        report: {
          ...report,
          score: 100,
          productCount: 0,
          affectedProductCount: 0,
          criticalCount: 0,
        } as unknown as HealthReport,
      },
    });

    const response = await getJsonReport(new Request("https://health.example.com/api/report"));

    const body = await response.json();
    expect(body.health.score).toBeNull();
    expect(body.health.state).toBe("unknown");
    expect(body.report).not.toHaveProperty("score");
  });

  it("reports a missing snapshot instead of silently starting a scan", async () => {
    mocks.getLatestProductHealthReport.mockResolvedValue({ source: "none" });

    const response = await getJsonReport(new Request("https://health.example.com/api/report"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "IKAS_SCAN_SNAPSHOT_MISSING" });
    expect(mocks.collectProductHealthReport).not.toHaveBeenCalled();
  });

  it("returns 401 without consulting report data when the installation session is missing", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await getJsonReport(new Request("https://health.example.com/api/report"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getLatestProductHealthReport).not.toHaveBeenCalled();
  });

  it("serves CSV from the same snapshot without putting an installation ID in the URL", async () => {
    const response = await getCsvReport(
      new Request("https://health.example.com/api/report.csv?authorizedAppId=attacker-app"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="ikas-product-health-report.csv"',
    );
    expect(mocks.getProductHealthReportCsv).toHaveBeenCalledWith(installation);
    expect(mocks.collectProductHealthReport).not.toHaveBeenCalled();
    expect(await response.text()).toBe("product,issue\n");
  });

  it("does not export an empty CSV when no scan has run yet", async () => {
    mocks.getProductHealthReportCsv.mockResolvedValue(undefined);

    const response = await getCsvReport(new Request("https://health.example.com/api/report.csv"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "IKAS_SCAN_SNAPSHOT_MISSING" });
    expect(mocks.collectProductHealthReport).not.toHaveBeenCalled();
  });

  it.each([
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
      error: new SnapshotStoreError("backend", "get"),
      status: 503,
      code: "IKAS_SNAPSHOT_BACKEND_UNAVAILABLE",
    },
    {
      name: "corrupt stored snapshots",
      error: new SnapshotStoreError("corrupt_record", "get"),
      status: 503,
      code: "IKAS_SNAPSHOT_BACKEND_UNAVAILABLE",
    },
    {
      name: "ikas upstream failures",
      error: new IkasUpstreamError("IKAS_UPSTREAM_GRAPHQL_ERROR"),
      status: 502,
      code: "IKAS_UPSTREAM_GRAPHQL_ERROR",
    },
    {
      name: "unexpected failures",
      error: new Error("unexpected"),
      status: 500,
      code: "IKAS_REPORT_FAILED",
    },
  ])("maps $name to a private safe CSV error", async ({ error, status, code }) => {
    mocks.getProductHealthReportCsv.mockRejectedValue(error);

    const response = await getCsvReport(new Request("https://health.example.com/api/report.csv"));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: code });
  });

  it("protects CSV errors from shared caching", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await getCsvReport(new Request("https://health.example.com/api/report.csv"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getProductHealthReportCsv).not.toHaveBeenCalled();
  });
});
