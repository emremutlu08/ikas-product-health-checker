import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import { IkasCircuitOpenError } from "@/lib/ikas/request-limiter";
import {
  computePlanHash,
  MAX_BULK_ITEMS,
  BULK_CONFIRMATION_TTL_MS,
  type BulkBatchRecord,
  type BulkBatchStore,
  type BulkPlanItem,
} from "./bulk-batch-store";
import {
  CorrectionPreviewError,
  type CorrectionPreparationDependencies,
  type CorrectionPreview,
  type CorrectionRequest,
} from "./mutation-preview";
import { prepareCorrection } from "./mutation-preview";
import { MAX_CONFIRMATION_TTL_MS, type MutationOperationStore } from "./mutation-operation-store";
import {
  executeConfirmedMutation,
  MutationExecutionError,
  reconcileMutation,
  type MutationExecutionDependencies,
} from "./product-mutation-service";

/**
 * Many corrections, one confirmation, and no new mutation rules.
 *
 * Every ready item is an ordinary confirmed operation, so a batch inherits per-item idempotency,
 * the atomic claim, the exact read-back and the audit record without restating any of it. What the
 * batch layer owns is the bounded, resumable, cancellable orchestration around them: the plan the
 * merchant approved, small chunks under the shared rate limiter, and the rule that a completed item
 * is never touched twice.
 */

export const BULK_CHUNK_SIZE = 5;
export const BULK_CONCURRENCY = 2;
/**
 * Two independent stop conditions, because they mean different things. Repeated *unknown* outcomes
 * mean the app can no longer tell what it is doing to the catalog. Repeated failures of any kind
 * mean the batch is achieving nothing while spending the merchant's ikas error budget — and ikas
 * blocks a store whose hourly error rate stays high, so continuing is worse than stopping.
 */
export const BULK_UNKNOWN_FAILURE_LIMIT = 3;
export const BULK_CONSECUTIVE_FAILURE_LIMIT = 5;

export type BulkPlanResult = {
  batchId: string;
  planHash: string;
  expiresAt: number;
  items: BulkPlanItem[];
  previews: Array<{ index: number; preview: CorrectionPreview }>;
};

export type BulkExecutionItemOutcome = {
  index: number;
  operationId: string;
  status: "succeeded" | "rejected" | "failed_unknown" | "skipped";
  reason?: string;
};

export type BulkExecutionResult = {
  batchId: string;
  status: "completed" | "cancelled" | "stopped";
  succeeded: number;
  rejected: number;
  failedUnknown: number;
  skipped: number;
  items: BulkExecutionItemOutcome[];
};

export type BulkPlanDependencies = CorrectionPreparationDependencies & {
  batchStore: Pick<BulkBatchStore, "create">;
  createBatchId(): string;
};

export type BulkExecutionDependencies = MutationExecutionDependencies & {
  batchStore: Pick<BulkBatchStore, "get" | "confirm" | "setStatus">;
  operationStore: Pick<MutationOperationStore, "claim" | "settle" | "get">;
};

export class BulkCorrectionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "too_many_items"
      | "duplicate_target"
      | "batch_missing"
      | "batch_expired"
      | "batch_replay"
      | "batch_cancelled"
      | "plan_mismatch"
      | "no_ready_items"
      | "write_disabled"
      | "feature_required",
  ) {
    super(code);
    this.name = "BulkCorrectionError";
  }
}

function planFailureReason(error: unknown): { state: BulkPlanItem["state"]; reason: string } {
  if (!(error instanceof CorrectionPreviewError)) return { state: "skipped", reason: "unavailable" };
  switch (error.code) {
    case "invalid_request":
    case "no_change":
      return { state: "invalid", reason: error.code };
    case "snapshot_stale":
    case "stale_guard_unavailable":
      return { state: "stale", reason: error.code };
    default:
      return { state: "skipped", reason: error.code };
  }
}

/**
 * Planning writes nothing to the catalog. It reserves one expiring operation per ready item and
 * hashes the resulting plan, so the confirmation that follows can only execute this exact list.
 */
export async function planBulkCorrection(
  installation: InstallationIdentity,
  requests: readonly CorrectionRequest[],
  dependencies: BulkPlanDependencies,
): Promise<BulkPlanResult> {
  if (requests.length === 0) throw new BulkCorrectionError("invalid_request");
  if (requests.length > MAX_BULK_ITEMS) throw new BulkCorrectionError("too_many_items");

  const seen = new Set<string>();
  for (const request of requests) {
    const target = `${request.kind}|${request.productId}|${request.variantId}`;
    if (seen.has(target)) throw new BulkCorrectionError("duplicate_target");
    seen.add(target);
  }

  const batchId = dependencies.createBatchId();
  const createdAt = dependencies.now();
  const items: BulkPlanItem[] = [];
  const previews: BulkPlanResult["previews"] = [];

  for (const [index, request] of requests.entries()) {
    try {
      const prepared = await prepareCorrection(
        installation,
        request,
        dependencies,
        // The longest window the store allows, so execution still has time after confirmation.
        { origin: "bulk", batchId, ttlMs: MAX_CONFIRMATION_TTL_MS },
      );
      items.push({
        index,
        productId: request.productId,
        variantId: request.variantId,
        state: "ready",
        operationId: prepared.operationId,
      });
      previews.push({ index, preview: prepared.preview });
    } catch (error) {
      const { state, reason } = planFailureReason(error);
      items.push({ index, productId: request.productId, variantId: request.variantId, state, reason });
    }
  }

  if (!items.some((item) => item.state === "ready")) {
    throw new BulkCorrectionError("no_ready_items");
  }

  const planHash = computePlanHash(batchId, items);
  const record: BulkBatchRecord = {
    version: 1,
    batchId,
    status: "planned",
    planHash,
    createdAt,
    expiresAt: createdAt + BULK_CONFIRMATION_TTL_MS,
    items,
  };
  const created = await dependencies.batchStore.create(installation, record);
  if (created !== "created") throw new BulkCorrectionError("invalid_request");

  return { batchId, planHash, expiresAt: record.expiresAt, items, previews };
}

function executionReason(error: unknown): { status: BulkExecutionItemOutcome["status"]; reason: string } {
  if (!(error instanceof MutationExecutionError)) {
    return { status: "failed_unknown", reason: "unavailable" };
  }
  if (
    error.code === "mutation_outcome_unknown" ||
    error.code === "verification_failed" ||
    error.code === "invariant_violation"
  ) {
    return { status: "failed_unknown", reason: error.code };
  }
  if (error.code === "confirmation_replay") return { status: "skipped", reason: error.code };
  return { status: "rejected", reason: error.code };
}

async function chunked<T, R>(
  items: readonly T[],
  size: number,
  concurrency: number,
  run: (item: T) => Promise<R>,
  shouldStop: () => Promise<boolean>,
): Promise<{ results: R[]; stopped: boolean }> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const chunk = items.slice(offset, offset + size);
    for (let inner = 0; inner < chunk.length; inner += concurrency) {
      // Checked before every concurrency group, not only between chunks: a stop condition that can
      // only be observed once per five items is not really a circuit breaker.
      if (await shouldStop()) return { results, stopped: true };
      results.push(...(await Promise.all(chunk.slice(inner, inner + concurrency).map(run))));
    }
  }
  return { results, stopped: false };
}

/**
 * Confirms a plan once and then runs it — or resumes one that is already confirmed.
 *
 * Resuming is the same call. An item whose operation already reached a terminal state is reported
 * from its audit record and never re-sent; an item left mid-flight by a crash is reconciled from
 * the catalog instead.
 *
 * A settled rejection stays settled, including one caused by a transport failure the read-back
 * proved did not apply. Retrying it would mean re-using a spent one-time confirmation, so those
 * items are reported instead and the merchant can plan a fresh batch for them.
 */
export async function executeBulkCorrection(
  installation: InstallationIdentity,
  batchId: string,
  planHash: string | undefined,
  dependencies: BulkExecutionDependencies,
): Promise<BulkExecutionResult> {
  if (!dependencies.writesEnabled()) throw new BulkCorrectionError("write_disabled");
  if (!(await dependencies.hasWriteFeature(installation))) {
    throw new BulkCorrectionError("feature_required");
  }

  const record = await dependencies.batchStore.get(installation, batchId);
  if (!record) throw new BulkCorrectionError("batch_missing");

  if (record.status === "planned") {
    if (!planHash) throw new BulkCorrectionError("plan_mismatch");
    const outcome = await dependencies.batchStore.confirm(
      installation,
      batchId,
      planHash,
      dependencies.now(),
    );
    if (outcome !== "confirmed") {
      throw new BulkCorrectionError(
        outcome === "missing"
          ? "batch_missing"
          : outcome === "expired"
            ? "batch_expired"
            : outcome === "cancelled"
              ? "batch_cancelled"
              : outcome === "plan_mismatch"
                ? "plan_mismatch"
                : "batch_replay",
      );
    }
  } else if (record.status === "cancelled") {
    throw new BulkCorrectionError("batch_cancelled");
  } else if (record.status === "completed") {
    throw new BulkCorrectionError("batch_replay");
  }

  await dependencies.batchStore.setStatus(installation, batchId, "running");

  const ready = record.items.filter(
    (item): item is BulkPlanItem & { operationId: string } =>
      item.state === "ready" && typeof item.operationId === "string",
  );
  const outcomes: BulkExecutionItemOutcome[] = [];
  let consecutiveUnknown = 0;
  let consecutiveFailures = 0;
  let circuitStopped = false;

  const runItem = async (item: BulkPlanItem & { operationId: string }) => {
    // A resumed batch must never re-send a write whose result is already durable.
    const existing = await dependencies.operationStore.get(installation, item.operationId);
    if (existing && existing.status !== "prepared") {
      if (existing.status === "executing") {
        await reconcileMutation(installation, item.operationId, dependencies).catch(() => undefined);
        const settled = await dependencies.operationStore.get(installation, item.operationId);
        const status = settled?.status === "succeeded" ? "succeeded" : "failed_unknown";
        return {
          index: item.index,
          operationId: item.operationId,
          status,
          ...(settled?.settlement && settled.settlement.status !== "succeeded"
            ? { reason: settled.settlement.reason }
            : {}),
        } satisfies BulkExecutionItemOutcome;
      }
      return {
        index: item.index,
        operationId: item.operationId,
        status: existing.status,
        ...(existing.settlement && existing.settlement.status !== "succeeded"
          ? { reason: existing.settlement.reason }
          : {}),
      } satisfies BulkExecutionItemOutcome;
    }

    try {
      await executeConfirmedMutation(installation, item.operationId, dependencies);
      consecutiveUnknown = 0;
      consecutiveFailures = 0;
      return { index: item.index, operationId: item.operationId, status: "succeeded" as const };
    } catch (error) {
      if (error instanceof IkasCircuitOpenError) circuitStopped = true;
      const { status, reason } = executionReason(error);
      consecutiveUnknown = status === "failed_unknown" ? consecutiveUnknown + 1 : 0;
      consecutiveFailures = status === "skipped" ? consecutiveFailures : consecutiveFailures + 1;
      return { index: item.index, operationId: item.operationId, status, reason };
    }
  };

  const { results, stopped } = await chunked(
    ready,
    BULK_CHUNK_SIZE,
    BULK_CONCURRENCY,
    runItem,
    async () => {
      if (
        circuitStopped ||
        consecutiveUnknown >= BULK_UNKNOWN_FAILURE_LIMIT ||
        consecutiveFailures >= BULK_CONSECUTIVE_FAILURE_LIMIT
      ) {
        return true;
      }
      const current = await dependencies.batchStore.get(installation, batchId);
      return current?.status === "cancelled";
    },
  );
  outcomes.push(...results);

  for (const item of record.items) {
    if (item.state === "ready") continue;
    outcomes.push({
      index: item.index,
      operationId: item.operationId ?? "",
      status: "skipped",
      ...(item.reason ? { reason: item.reason } : {}),
    });
  }
  outcomes.sort((left, right) => left.index - right.index);

  const cancelled = (await dependencies.batchStore.get(installation, batchId))?.status === "cancelled";
  // A batch only closes when every item reached a state the audit can defend. An item left in
  // `failed_unknown` keeps the batch resumable so reconciliation can finish it later.
  const unresolved = outcomes.some((item) => item.status === "failed_unknown");
  const status = cancelled ? "cancelled" : stopped || unresolved ? "stopped" : "completed";
  if (status === "completed") {
    await dependencies.batchStore.setStatus(installation, batchId, "completed");
  }

  return {
    batchId,
    status,
    succeeded: outcomes.filter((item) => item.status === "succeeded").length,
    rejected: outcomes.filter((item) => item.status === "rejected").length,
    failedUnknown: outcomes.filter((item) => item.status === "failed_unknown").length,
    skipped: outcomes.filter((item) => item.status === "skipped").length,
    items: outcomes,
  };
}

/** Stops new items from starting. Anything already in flight still settles through its own audit. */
export async function cancelBulkCorrection(
  installation: InstallationIdentity,
  batchId: string,
  dependencies: { batchStore: Pick<BulkBatchStore, "get" | "setStatus"> },
): Promise<"cancelled" | "not_cancellable"> {
  const record = await dependencies.batchStore.get(installation, batchId);
  if (!record) throw new BulkCorrectionError("batch_missing");
  if (record.status === "completed") return "not_cancellable";
  if (record.status === "cancelled") return "cancelled";
  const changed = await dependencies.batchStore.setStatus(installation, batchId, "cancelled");
  return changed ? "cancelled" : "not_cancellable";
}
