import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  getProductHealthReport: vi.fn(),
  getProductHealthReportCsv: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/ikas/report-service", () => ({
  getProductHealthReport: mocks.getProductHealthReport,
  getProductHealthReportCsv: mocks.getProductHealthReportCsv,
}));

import { GET as getJsonReport } from "./route";
import { GET as getCsvReport } from "../report.csv/route";

const installation = {
  authorizedAppId: "session-app",
  merchantId: "session-merchant",
  storeName: "session-store",
};

beforeEach(() => {
  vi.clearAllMocks();
  const session = { ...installation };
  mocks.getSession.mockResolvedValue(session);
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.getProductHealthReport.mockResolvedValue({ source: "http", report: { score: 100 } });
  mocks.getProductHealthReportCsv.mockResolvedValue("product,issue\n");
});

describe("tenant-bound report routes", () => {
  it("ignores a hostile query selector and uses only the validated installation session", async () => {
    const response = await getJsonReport(
      new Request("https://health.example.com/api/report?authorizedAppId=attacker-app"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getProductHealthReport).toHaveBeenCalledOnce();
    expect(mocks.getProductHealthReport.mock.calls[0]?.[1]).toEqual(installation);
    expect(mocks.getProductHealthReport).not.toHaveBeenCalledWith(
      expect.anything(),
      "attacker-app",
    );
  });

  it("returns 401 without consulting report data when the installation session is missing", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await getJsonReport(new Request("https://health.example.com/api/report"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getProductHealthReport).not.toHaveBeenCalled();
  });

  it("serves CSV for the session tenant without putting an installation ID in the URL", async () => {
    const response = await getCsvReport(
      new Request("https://health.example.com/api/report.csv?authorizedAppId=attacker-app"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(mocks.getProductHealthReportCsv).toHaveBeenCalledWith(installation);
    expect(await response.text()).toBe("product,issue\n");
  });

  it("protects CSV errors from shared caching", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await getCsvReport(new Request("https://health.example.com/api/report.csv"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getProductHealthReportCsv).not.toHaveBeenCalled();
  });
});
