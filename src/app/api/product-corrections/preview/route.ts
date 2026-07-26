import {
  correctionJson,
  correctionRequestSchema,
  describeCorrectionFailure,
  guardCorrectionRequest,
  logCorrectionFailure,
  toCorrectionRequest,
} from "@/lib/mutations/correction-http";
import {
  createCorrectionReadRuntime,
  hasCorrectionWriteFeature,
  productWritesEnabled,
} from "@/lib/mutations/correction-runtime";
import { prepareCorrection } from "@/lib/mutations/mutation-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Plans a correction and reserves a one-time confirmation for it. This route performs no
 * mutation: it reads the stored scan, reads the live product, and stores an expiring operation
 * whose id is the only thing the client gets back.
 *
 * It is gated exactly like the write it leads to, so a merchant is never shown a before/after
 * they would not be allowed to confirm.
 */
export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const guard = await guardCorrectionRequest(request, correctionRequestSchema);
  if ("response" in guard) return guard.response;

  try {
    if (!productWritesEnabled()) {
      return correctionJson({ error: "IKAS_CORRECTION_WRITE_DISABLED" }, 403);
    }
    if (!(await hasCorrectionWriteFeature(guard.installation))) {
      return correctionJson({ error: "IKAS_CORRECTION_FEATURE_REQUIRED" }, 403);
    }

    const dependencies = await createCorrectionReadRuntime(guard.installation);
    const prepared = await prepareCorrection(
      guard.installation,
      toCorrectionRequest(guard.body),
      dependencies,
    );

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
    logCorrectionFailure("ikas_correction_preview", correlationId, code);
    return correctionJson({ error: code }, status);
  }
}
