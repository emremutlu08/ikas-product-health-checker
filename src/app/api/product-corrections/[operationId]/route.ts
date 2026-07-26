import {
  correctionJson,
  describeCorrectionFailure,
  logCorrectionFailure,
  operationReferenceSchema,
} from "@/lib/mutations/correction-http";
import { createCorrectionReadRuntime } from "@/lib/mutations/correction-runtime";
import { mutationOperationStore } from "@/lib/mutations/mutation-operation-store";
import { reconcileMutation } from "@/lib/mutations/product-mutation-service";
import { getSession, readInstallationSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The outcome of one operation, and the crash-recovery path.
 *
 * A request that finds an operation still `executing` long after its claim reconciles it from the
 * live catalog rather than repeating a non-idempotent write, so a merchant who reloads after a
 * dropped connection gets a real answer instead of a spinner.
 */
export async function GET(_request: Request, context: { params: Promise<{ operationId: string }> }) {
  const correlationId = crypto.randomUUID();

  try {
    const installation = readInstallationSession(await getSession());
    if (!installation) return correctionJson({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401);

    const { operationId } = await context.params;
    const reference = operationReferenceSchema.safeParse({ operationId });
    if (!reference.success) {
      return correctionJson({ error: "IKAS_CORRECTION_INVALID_REQUEST" }, 400);
    }

    const store = mutationOperationStore();
    const existing = await store.get(installation, reference.data.operationId);
    if (!existing) return correctionJson({ error: "IKAS_CORRECTION_CONFIRMATION_MISSING" }, 404);

    if (existing.status === "executing") {
      const { readProduct } = await createCorrectionReadRuntime(installation);
      await reconcileMutation(installation, reference.data.operationId, {
        operationStore: store,
        readProduct,
        now: () => Date.now(),
      });
    }

    const record = await store.get(installation, reference.data.operationId);
    if (!record) return correctionJson({ error: "IKAS_CORRECTION_CONFIRMATION_MISSING" }, 404);

    // Only the operation's own scalars are returned; the stored payload never leaves as-is.
    return correctionJson(
      {
        operationId: record.payload.operationId,
        kind: record.payload.kind,
        origin: record.payload.origin,
        status: record.status,
        productId: record.payload.productId,
        variantId: record.payload.variantId,
        ...(record.settlement?.status === "succeeded"
          ? { verifiedValue: record.settlement.verifiedValue }
          : {}),
        ...(record.settlement && record.settlement.status !== "succeeded"
          ? { reason: record.settlement.reason }
          : {}),
      },
      200,
    );
  } catch (error) {
    const { status, code } = describeCorrectionFailure(error);
    logCorrectionFailure("ikas_correction_status", correlationId, code);
    return correctionJson({ error: code }, status);
  }
}
