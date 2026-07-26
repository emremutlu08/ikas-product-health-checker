import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readInstallationSession: vi.fn(),
  getCanonicalAppOrigin: vi.fn(),
  productWritesEnabled: vi.fn(),
  hasCorrectionWriteFeature: vi.fn(),
  createCorrectionReadRuntime: vi.fn(),
  createCorrectionRuntime: vi.fn(),
  prepareCorrection: vi.fn(),
  prepareUndo: vi.fn(),
  executeConfirmedMutation: vi.fn(),
  reconcileMutation: vi.fn(),
  mutationOperationStore: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  readInstallationSession: mocks.readInstallationSession,
}));

vi.mock("@/helpers/api-helpers", () => ({
  getCanonicalAppOrigin: mocks.getCanonicalAppOrigin,
}));

vi.mock("@/lib/mutations/correction-runtime", () => ({
  productWritesEnabled: mocks.productWritesEnabled,
  hasCorrectionWriteFeature: mocks.hasCorrectionWriteFeature,
  createCorrectionReadRuntime: mocks.createCorrectionReadRuntime,
  createCorrectionRuntime: mocks.createCorrectionRuntime,
}));

vi.mock("@/lib/mutations/mutation-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mutations/mutation-preview")>()),
  prepareCorrection: mocks.prepareCorrection,
}));

vi.mock("@/lib/mutations/mutation-undo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mutations/mutation-undo")>()),
  prepareUndo: mocks.prepareUndo,
}));

vi.mock("@/lib/mutations/product-mutation-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mutations/product-mutation-service")>()),
  executeConfirmedMutation: mocks.executeConfirmedMutation,
  reconcileMutation: mocks.reconcileMutation,
}));

vi.mock("@/lib/mutations/mutation-operation-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mutations/mutation-operation-store")>()),
  mutationOperationStore: mocks.mutationOperationStore,
}));

import { GET as statusRoute } from "./[operationId]/route";
import { POST as confirmRoute } from "./confirm/route";
import { POST as previewRoute } from "./preview/route";
import { POST as undoRoute } from "./undo/route";
import { CorrectionPreviewError } from "@/lib/mutations/mutation-preview";
import { MutationExecutionError } from "@/lib/mutations/product-mutation-service";
import { UndoPreparationError } from "@/lib/mutations/mutation-undo";
import { MutationOperationStoreError } from "@/lib/mutations/mutation-operation-store";

const ORIGIN = "https://health.example.com";
const installation = {
  authorizedAppId: "session-app",
  merchantId: "session-merchant",
  storeName: "session-store",
};

const skuBody = {
  kind: "sku_change",
  productId: "product-1",
  variantId: "variant-1",
  proposedSku: "NEW-SKU",
};

function postRequest(
  path: string,
  body: unknown,
  { origin = ORIGIN, contentType = "application/json" }: { origin?: string | null; contentType?: string | null } = {},
) {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  if (contentType !== null) headers.set("content-type", contentType);
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({});
  mocks.readInstallationSession.mockReturnValue(installation);
  mocks.getCanonicalAppOrigin.mockReturnValue(ORIGIN);
  mocks.productWritesEnabled.mockReturnValue(true);
  mocks.hasCorrectionWriteFeature.mockResolvedValue(true);
  mocks.createCorrectionReadRuntime.mockResolvedValue({ readProduct: vi.fn() });
  mocks.createCorrectionRuntime.mockResolvedValue({ readProduct: vi.fn(), writer: {} });
  mocks.prepareCorrection.mockResolvedValue({
    operationId: "operation-1",
    expiresAt: 1_753_000_700_000,
    preview: { kind: "sku_change", mode: "preview_only" },
  });
});

describe("POST /api/product-corrections/preview", () => {
  it("returns an opaque operation id and the before/after preview", async () => {
    const response = await previewRoute(postRequest("/api/product-corrections/preview", skuBody));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      operationId: "operation-1",
      expiresAt: new Date(1_753_000_700_000).toISOString(),
      preview: { mode: "preview_only" },
    });
  });

  it("refuses a cross-origin submission before reading the session", async () => {
    const response = await previewRoute(
      postRequest("/api/product-corrections/preview", skuBody, { origin: "https://evil.example" }),
    );

    expect(response.status).toBe(403);
    expect(mocks.readInstallationSession).not.toHaveBeenCalled();
  });

  it("refuses a request with no sealed installation session", async () => {
    mocks.readInstallationSession.mockReturnValue(undefined);

    const response = await previewRoute(postRequest("/api/product-corrections/preview", skuBody));

    expect(response.status).toBe(401);
    expect(mocks.prepareCorrection).not.toHaveBeenCalled();
  });

  it("ignores a tenant selector smuggled into the body by refusing the whole request", async () => {
    const response = await previewRoute(
      postRequest("/api/product-corrections/preview", {
        ...skuBody,
        merchantId: "someone-else",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.prepareCorrection).not.toHaveBeenCalled();
  });

  it("passes only the session installation to the planner", async () => {
    await previewRoute(postRequest("/api/product-corrections/preview", skuBody));

    expect(mocks.prepareCorrection).toHaveBeenCalledWith(installation, skuBody, expect.anything());
  });

  it("rejects a non-JSON content type and an oversized body", async () => {
    expect(
      (
        await previewRoute(
          postRequest("/api/product-corrections/preview", skuBody, { contentType: "text/plain" }),
        )
      ).status,
    ).toBe(415);

    expect(
      (
        await previewRoute(
          postRequest("/api/product-corrections/preview", {
            ...skuBody,
            proposedSku: "x".repeat(4_000),
          }),
        )
      ).status,
    ).toBe(413);
  });

  it("stays closed while the server-only kill switch is off", async () => {
    mocks.productWritesEnabled.mockReturnValue(false);

    const response = await previewRoute(postRequest("/api/product-corrections/preview", skuBody));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "IKAS_CORRECTION_WRITE_DISABLED" });
    expect(mocks.prepareCorrection).not.toHaveBeenCalled();
  });

  it("stays closed without a live write entitlement", async () => {
    mocks.hasCorrectionWriteFeature.mockResolvedValue(false);

    const response = await previewRoute(postRequest("/api/product-corrections/preview", skuBody));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "IKAS_CORRECTION_FEATURE_REQUIRED" });
  });

  it("maps planning failures onto sanitized statuses", async () => {
    const cases: Array<[CorrectionPreviewError["code"], number]> = [
      ["issue_not_found", 404],
      ["snapshot_stale", 409],
      ["no_change", 409],
      ["invalid_request", 400],
      ["price_row_ambiguous", 409],
    ];

    for (const [code, status] of cases) {
      mocks.prepareCorrection.mockRejectedValueOnce(new CorrectionPreviewError(code));
      const response = await previewRoute(postRequest("/api/product-corrections/preview", skuBody));
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        error: `IKAS_CORRECTION_${code.toUpperCase()}`,
      });
    }
  });

  it("never leaks upstream detail from an unexpected failure", async () => {
    mocks.prepareCorrection.mockRejectedValueOnce(new Error("token abc123 rejected by ikas"));

    const response = await previewRoute(postRequest("/api/product-corrections/preview", skuBody));

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("abc123");
  });
});

describe("POST /api/product-corrections/confirm", () => {
  it("accepts nothing but an opaque operation id", async () => {
    mocks.executeConfirmedMutation.mockResolvedValue({
      status: "succeeded",
      operationId: "operation-1",
      kind: "sku_change",
      verifiedValue: "NEW-SKU",
    });

    const response = await confirmRoute(
      postRequest("/api/product-corrections/confirm", { operationId: "operation-1" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.executeConfirmedMutation).toHaveBeenCalledWith(
      installation,
      "operation-1",
      expect.anything(),
    );
  });

  it("refuses a confirmation carrying client-controlled expected values", async () => {
    const response = await confirmRoute(
      postRequest("/api/product-corrections/confirm", {
        operationId: "operation-1",
        expectedPreviousSku: "anything",
        proposedSku: "OVERRIDE",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.executeConfirmedMutation).not.toHaveBeenCalled();
  });

  it("maps every execution outcome onto its documented status", async () => {
    const cases: Array<[MutationExecutionError["code"], number]> = [
      ["write_disabled", 403],
      ["feature_required", 403],
      ["confirmation_replay", 409],
      ["confirmation_expired", 410],
      ["confirmation_missing", 404],
      ["stale_product", 412],
      ["stale_value", 412],
      ["write_rejected", 422],
      ["rate_limited", 429],
      ["preflight_failed", 503],
      ["invariant_violation", 409],
      ["verification_failed", 409],
      ["mutation_outcome_unknown", 409],
    ];

    for (const [code, status] of cases) {
      mocks.executeConfirmedMutation.mockRejectedValueOnce(new MutationExecutionError(code));
      const response = await confirmRoute(
        postRequest("/api/product-corrections/confirm", { operationId: "operation-1" }),
      );
      expect(response.status, code).toBe(status);
    }
  });

  it("reports a durable-store outage as unavailable rather than as a failed write", async () => {
    mocks.executeConfirmedMutation.mockRejectedValueOnce(
      new MutationOperationStoreError("backend"),
    );

    const response = await confirmRoute(
      postRequest("/api/product-corrections/confirm", { operationId: "operation-1" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "IKAS_CORRECTION_BACKEND_UNAVAILABLE",
    });
  });
});

describe("POST /api/product-corrections/undo", () => {
  it("prepares a rollback as a fresh one-time confirmation", async () => {
    mocks.prepareUndo.mockResolvedValue({
      operationId: "undo-1",
      expiresAt: 1_753_000_700_000,
      preview: { kind: "sku_change", mode: "preview_only" },
    });

    const response = await undoRoute(
      postRequest("/api/product-corrections/undo", { operationId: "operation-1" }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ operationId: "undo-1" });
  });

  it("refuses a rollback whose baseline someone else has changed", async () => {
    mocks.prepareUndo.mockRejectedValueOnce(new UndoPreparationError("undo_baseline_changed"));

    const response = await undoRoute(
      postRequest("/api/product-corrections/undo", { operationId: "operation-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "IKAS_CORRECTION_UNDO_BASELINE_CHANGED",
    });
  });
});

describe("GET /api/product-corrections/[operationId]", () => {
  function statusRequest() {
    return new Request(`${ORIGIN}/api/product-corrections/operation-1`);
  }

  it("returns the settled outcome without echoing the stored payload", async () => {
    mocks.mutationOperationStore.mockReturnValue({
      get: vi.fn(async () => ({
        status: "succeeded",
        payload: {
          operationId: "operation-1",
          kind: "sku_change",
          origin: "single",
          productId: "product-1",
          variantId: "variant-1",
          expectedPreviousSku: "OLD-SKU",
          proposedSku: "NEW-SKU",
        },
        settlement: { status: "succeeded", completedAt: 1, verifiedValue: "NEW-SKU" },
      })),
    });

    const response = await statusRoute(statusRequest(), {
      params: Promise.resolve({ operationId: "operation-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      operationId: "operation-1",
      kind: "sku_change",
      origin: "single",
      status: "succeeded",
      productId: "product-1",
      variantId: "variant-1",
      verifiedValue: "NEW-SKU",
    });
    expect(JSON.stringify(body)).not.toContain("OLD-SKU");
  });

  it("reconciles an abandoned executing operation instead of leaving it open", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: "executing", payload: { operationId: "operation-1" } })
      .mockResolvedValueOnce({
        status: "rejected",
        payload: {
          operationId: "operation-1",
          kind: "sku_change",
          origin: "single",
          productId: "product-1",
          variantId: "variant-1",
        },
        settlement: { status: "rejected", completedAt: 1, reason: "write_rejected" },
      });
    mocks.mutationOperationStore.mockReturnValue({ get });

    const response = await statusRoute(statusRequest(), {
      params: Promise.resolve({ operationId: "operation-1" }),
    });

    expect(mocks.reconcileMutation).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      status: "rejected",
      reason: "write_rejected",
    });
  });

  it("refuses without a session and 404s an operation this tenant does not own", async () => {
    mocks.readInstallationSession.mockReturnValueOnce(undefined);
    expect(
      (
        await statusRoute(statusRequest(), {
          params: Promise.resolve({ operationId: "operation-1" }),
        })
      ).status,
    ).toBe(401);

    mocks.mutationOperationStore.mockReturnValue({ get: vi.fn(async () => undefined) });
    expect(
      (
        await statusRoute(statusRequest(), {
          params: Promise.resolve({ operationId: "operation-1" }),
        })
      ).status,
    ).toBe(404);
  });
});
