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

const report = { score: 100, issues: [] } as unknown as HealthReport;

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
    expect(body).toEqual({ scanId: "scan-1", generatedAt: "2026-07-20T08:00:00.000Z", report });
    expect(JSON.stringify(body)).not.toContain("session-app");
    expect(JSON.stringify(body)).not.toContain("session-merchant");
    expect(mocks.collectProductHealthReport).not.toHaveBeenCalled();
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
