import { z } from "zod";
import {
  correctionJson,
  correctionRequestSchema,
  describeCorrectionFailure,
  guardCorrectionRequest,
  logCorrectionFailure,
  MAX_BULK_BODY_BYTES,
} from "@/lib/mutations/correction-http";
import {
  bulkWritesEnabled,
  createCorrectionReadRuntime,
  createCorrectionRuntime,
  hasBulkWriteFeature,
  hasCorrectionWriteFeature,
} from "@/lib/mutations/correction-runtime";
import { bulkBatchStore, MAX_BULK_ITEMS } from "@/lib/mutations/bulk-batch-store";
import {
  BulkCorrectionError,
  cancelBulkCorrection,
  executeBulkCorrection,
  planBulkCorrection,
} from "@/lib/mutations/bulk-correction-service";
import { mutationOperationStore } from "@/lib/mutations/mutation-operation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);

/**
 * One endpoint, three explicit actions, so a merchant cannot reach execution by replaying a plan
 * request. Every action is same-origin, tenant-bound to the sealed session, and gated behind both
 * the single-write kill switch and the separate bulk switch.
 */
const bulkRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("plan"),
    items: z.array(correctionRequestSchema).min(1).max(MAX_BULK_ITEMS),
  }),
  z.strictObject({
    action: z.literal("execute"),
    batchId: identifier,
    /** Required only for the first run; a resume needs nothing but the batch id. */
    planHash: z.string().length(43).optional(),
  }),
  z.strictObject({ action: z.literal("cancel"), batchId: identifier }),
]);

const BULK_ERROR_STATUS: Record<BulkCorrectionError["code"], number> = {
  invalid_request: 400,
  too_many_items: 413,
  duplicate_target: 400,
  batch_missing: 404,
  batch_expired: 410,
  batch_replay: 409,
  batch_cancelled: 409,
  plan_mismatch: 409,
  no_ready_items: 409,
  write_disabled: 403,
  feature_required: 403,
};

function describeBulkFailure(error: unknown) {
  if (error instanceof BulkCorrectionError) {
    return { status: BULK_ERROR_STATUS[error.code], code: `IKAS_BULK_${error.code.toUpperCase()}` };
  }
  return describeCorrectionFailure(error);
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const guard = await guardCorrectionRequest(request, bulkRequestSchema, MAX_BULK_BODY_BYTES);
  if ("response" in guard) return guard.response;

  try {
    if (!bulkWritesEnabled()) {
      return correctionJson({ error: "IKAS_BULK_WRITE_DISABLED" }, 403);
    }
    // Both grants: bulk is its own capability, and it still needs the single-write one it builds on.
    if (
      !(await hasCorrectionWriteFeature(guard.installation)) ||
      !(await hasBulkWriteFeature(guard.installation))
    ) {
      return correctionJson({ error: "IKAS_BULK_FEATURE_REQUIRED" }, 403);
    }

    if (guard.body.action === "plan") {
      const dependencies = await createCorrectionReadRuntime(guard.installation);
      const plan = await planBulkCorrection(guard.installation, guard.body.items, {
        ...dependencies,
        batchStore: bulkBatchStore(),
        createBatchId: () => crypto.randomUUID(),
      });
      return correctionJson(
        {
          batchId: plan.batchId,
          planHash: plan.planHash,
          expiresAt: new Date(plan.expiresAt).toISOString(),
          items: plan.items,
          previews: plan.previews,
        },
        201,
      );
    }

    if (guard.body.action === "cancel") {
      const outcome = await cancelBulkCorrection(guard.installation, guard.body.batchId, {
        batchStore: bulkBatchStore(),
      });
      return correctionJson({ batchId: guard.body.batchId, outcome }, 200);
    }

    const { readProduct, writer } = await createCorrectionRuntime(guard.installation);
    const result = await executeBulkCorrection(
      guard.installation,
      guard.body.batchId,
      guard.body.planHash,
      {
        writesEnabled: () => bulkWritesEnabled(),
        hasWriteFeature: hasCorrectionWriteFeature,
        operationStore: mutationOperationStore(),
        batchStore: bulkBatchStore(),
        readProduct,
        writer,
        now: () => Date.now(),
      },
    );
    return correctionJson(result, 200);
  } catch (error) {
    const { status, code } = describeBulkFailure(error);
    logCorrectionFailure("ikas_correction_bulk", correlationId, code);
    return correctionJson({ error: code }, status);
  }
}
