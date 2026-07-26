import {
  correctionJson,
  describeCorrectionFailure,
  guardCorrectionRequest,
  logCorrectionFailure,
  operationReferenceSchema,
} from "@/lib/mutations/correction-http";
import {
  createCorrectionReadRuntime,
  hasCorrectionWriteFeature,
  productWritesEnabled,
} from "@/lib/mutations/correction-runtime";
import { prepareUndo } from "@/lib/mutations/mutation-undo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prepares a rollback of a settled correction. Like every other write, it only reserves a
 * confirmation here; the merchant still has to confirm it through the same execution route,
 * and the rollback is refused outright if the value is no longer the one this app wrote.
 */
export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const guard = await guardCorrectionRequest(request, operationReferenceSchema);
  if ("response" in guard) return guard.response;

  try {
    if (!productWritesEnabled()) {
      return correctionJson({ error: "IKAS_CORRECTION_WRITE_DISABLED" }, 403);
    }
    if (!(await hasCorrectionWriteFeature(guard.installation))) {
      return correctionJson({ error: "IKAS_CORRECTION_FEATURE_REQUIRED" }, 403);
    }

    const dependencies = await createCorrectionReadRuntime(guard.installation);
    const prepared = await prepareUndo(guard.installation, guard.body.operationId, dependencies);

    return correctionJson(
      {
        operationId: prepared.operationId,
        expiresAt: new Date(prepared.expiresAt).toISOString(),
        preview: prepared.preview,
      },
      201,
    );
  } catch (error) {
    const { status, code } = describeCorrectionFailure(error);
    logCorrectionFailure("ikas_correction_undo", correlationId, code);
    return correctionJson({ error: code }, status);
  }
}
