import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryAccessError } from "@/lib/billing/history-service";
import { SnapshotStoreError } from "@/lib/scans/snapshot-store";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  getProductHealthHistory: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/lib/billing/history-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/history-service")>()),
  getProductHealthHistory: mocks.getProductHealthHistory,
}));

vi.mock("@/components/IkasAppBridgeReady", () => ({ IkasAppBridgeReady: () => null }));

import HistoryPage from "./page";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
};

function historyResult() {
  return {
    tier: "pro" as const,
    entries: [
      {
        scanId: "scan-2",
        generatedAt: "2026-07-22T08:00:00.000Z",
        health: { state: "attention" as const, score: 82, label: "Dikkat gerekiyor", weightedIssuePoints: 3 },
        productCount: 31,
        affectedProductCount: 3,
        issueCount: 4,
        changes: { baseline: "available" as const, added: 1, ongoing: 2, resolved: 3 },
      },
      {
        scanId: "scan-1",
        generatedAt: "2026-07-21T08:00:00.000Z",
        health: { state: "healthy" as const, score: 95, label: "Sağlıklı", weightedIssuePoints: 1 },
        productCount: 30,
        affectedProductCount: 1,
        issueCount: 1,
        changes: { baseline: "missing" as const, added: 0, ongoing: 0, resolved: 0 },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(installation);
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.getProductHealthHistory.mockResolvedValue(historyResult());
});

async function renderPage() {
  return renderToStaticMarkup(await HistoryPage());
}

describe("history page", () => {
  it("requires an installation without calling the Pro boundary", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const html = await renderPage();

    expect(html).toContain("ikas mağazanızla açın");
    expect(mocks.getProductHealthHistory).not.toHaveBeenCalled();
  });

  it("shows a truthful generic Pro-required state without guessing the current plan", async () => {
    mocks.getProductHealthHistory.mockRejectedValue(new HistoryAccessError());

    const html = await renderPage();

    expect(html).toContain("Tarama geçmişi Pro özelliğidir");
    expect(html).toContain("Ürün Sağlığına dön");
    expect(html).not.toContain("Mevcut planınız Free");
    expect(html).not.toContain("Satın al");
  });

  it("shows an empty Pro history state after a verified grant", async () => {
    mocks.getProductHealthHistory.mockResolvedValue({ tier: "pro", entries: [] });

    const html = await renderPage();

    expect(html).toContain("Tarama Geçmişi");
    expect(html).toContain("Plan: Pro");
    expect(html).toContain("Henüz geçmiş kaydı yok");
  });

  it("renders newest-first health and diff summaries with accessible labels", async () => {
    const html = await renderPage();

    expect(html.indexOf("scan-2")).toBeLessThan(html.indexOf("scan-1"));
    expect(html).toContain("Yeni sorun");
    expect(html).toContain("1");
    expect(html).toContain("Devam eden");
    expect(html).toContain("2");
    expect(html).toContain("Çözülen");
    expect(html).toContain("3");
    expect(html).toContain("Karşılaştırma için önceki tarama yok");
    expect(html).toContain('dateTime="2026-07-22T08:00:00.000Z"');
    expect(html).toContain('aria-label="Tarama geçmişi"');
    expect(html).toContain('aria-label="scan-2 tarama değişimleri"');
  });

  it("shows a fixed recoverable state for snapshot backend failures", async () => {
    mocks.getProductHealthHistory.mockRejectedValue(
      new SnapshotStoreError("backend", "history"),
    );

    const html = await renderPage();

    expect(html).toContain("Geçmiş şu anda yüklenemiyor");
    expect(html).not.toContain("IKAS_SNAPSHOT_STORE_BACKEND");
  });

  it("does not render tenant identifiers supplied by the sealed session", async () => {
    const html = await renderPage();

    expect(html).not.toContain(installation.authorizedAppId);
    expect(html).not.toContain(installation.merchantId);
    expect(mocks.getProductHealthHistory).toHaveBeenCalledWith(installation);
  });
});
