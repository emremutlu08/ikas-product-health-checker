import {
  correctionJson,
  describeCorrectionFailure,
  guardCorrectionRequest,
  logCorrectionFailure,
  operationReferenceSchema,
} from "@/lib/mutations/correction-http";
import {
  createCorrectionRuntime,
  hasCorrectionWriteFeature,
  productWritesEnabled,
} from "@/lib/mutations/correction-runtime";
import { mutationOperationStore } from "@/lib/mutations/mutation-operation-store";
import { executeConfirmedMutation } from "@/lib/mutations/product-mutation-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Executes a correction the merchant already confirmed.
 *
 * The body carries an opaque operation id and nothing else — no tenant, no product, no value —
 * so a replayed or tampered request can only ever address an operation that was previewed for
 * this installation, and only once.
 */
export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const guard = await guardCorrectionRequest(request, operationReferenceSchema);
  if ("response" in guard) return guard.response;

  try {
    const { readProduct, writer } = await createCorrectionRuntime(guard.installation);
    const result = await executeConfirmedMutation(guard.installation, guard.body.operationId, {
      writesEnabled: () => productWritesEnabled(),
      hasWriteFeature: hasCorrectionWriteFeature,
      operationStore: mutationOperationStore(),
      readProduct,
      writer,
      now: () => Date.now(),
      // A bulk item belongs to its batch: executing it here would slip past the separate bulk
      // switch, and past a cancellation.
      acceptsOrigin: (origin) => origin !== "bulk",
    });

    return correctionJson(result, 200);
  } catch (error) {
    const { status, code } = describeCorrectionFailure(error);
    logCorrectionFailure("ikas_correction_confirm", correlationId, code);
    return correctionJson({ error: code }, status);
  }
}
