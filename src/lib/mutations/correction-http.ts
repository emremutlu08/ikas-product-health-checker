import { z } from "zod";
import { getCanonicalAppOrigin } from "@/helpers/api-helpers";
import { IkasAuthenticationError, IkasUpstreamError } from "@/lib/ikas/errors";
import { TokenStoreError } from "@/lib/ikas/token-store";
import { readInstallationSession, getSession } from "@/lib/session";
import type { InstallationIdentity } from "@/lib/ikas/installation-auth";
import { CorrectionPreviewError, type CorrectionRequest } from "./mutation-preview";
import { MutationOperationStoreError } from "./mutation-operation-store";
import { MutationExecutionError } from "./product-mutation-service";
import { UndoPreparationError } from "./mutation-undo";

/**
 * The HTTP boundary for product corrections.
 *
 * Every mutating request must be same-origin, carry a small strict JSON body, and belong to a
 * sealed installation session. The body may describe *what* to change but never *whose* catalog:
 * the tenant comes from the session alone, and the confirmation body carries nothing but an
 * opaque operation id.
 */

export const MAX_CORRECTION_BODY_BYTES = 2_048;
export const CORRECTION_PRIVATE_HEADERS = { "cache-control": "private, no-store" } as const;

const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);

export const correctionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("sku_change"),
    productId: identifier,
    variantId: identifier,
    proposedSku: z.string().min(1).max(128),
  }),
  z.strictObject({
    kind: z.literal("price_change"),
    productId: identifier,
    variantId: identifier,
    proposedSellPrice: z.string().min(1).max(32),
  }),
  z.strictObject({
    kind: z.literal("stock_change"),
    productId: identifier,
    variantId: identifier,
    stockLocationId: identifier.optional(),
    proposedStockCount: z.number(),
  }),
]);

export const operationReferenceSchema = z.strictObject({ operationId: identifier });

export function correctionJson(body: unknown, status: number) {
  return Response.json(body, { status, headers: CORRECTION_PRIVATE_HEADERS });
}

export type RequestGuardFailure = { response: Response };
export type RequestGuardSuccess<T> = { installation: InstallationIdentity; body: T };

function isJsonContentType(request: Request) {
  const header = request.headers.get("content-type");
  return Boolean(header && header.split(";")[0]!.trim().toLowerCase() === "application/json");
}

/**
 * Same-origin, small, strictly-shaped, and tenant-bound — in that order, so an unauthenticated
 * caller learns nothing about the schema and an oversized body is never buffered into a parser.
 */
export async function guardCorrectionRequest<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<RequestGuardFailure | RequestGuardSuccess<z.infer<T>>> {
  let canonicalOrigin: string;
  try {
    canonicalOrigin = getCanonicalAppOrigin();
  } catch {
    return { response: correctionJson({ error: "IKAS_CORRECTION_UNAVAILABLE" }, 503) };
  }
  if (request.headers.get("origin") !== canonicalOrigin) {
    return { response: correctionJson({ error: "IKAS_CORRECTION_ORIGIN_INVALID" }, 403) };
  }

  const installation = readInstallationSession(await getSession());
  if (!installation) {
    return { response: correctionJson({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401) };
  }

  if (!isJsonContentType(request)) {
    return { response: correctionJson({ error: "IKAS_CORRECTION_INVALID_REQUEST" }, 415) };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { response: correctionJson({ error: "IKAS_CORRECTION_INVALID_REQUEST" }, 400) };
  }
  if (raw.length > MAX_CORRECTION_BODY_BYTES) {
    return { response: correctionJson({ error: "IKAS_CORRECTION_INVALID_REQUEST" }, 413) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { response: correctionJson({ error: "IKAS_CORRECTION_INVALID_REQUEST" }, 400) };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { response: correctionJson({ error: "IKAS_CORRECTION_INVALID_REQUEST" }, 400) };
  }
  return { installation, body: result.data as z.infer<T> };
}

export function toCorrectionRequest(
  body: z.infer<typeof correctionRequestSchema>,
): CorrectionRequest {
  return body;
}

const PREVIEW_STATUS: Record<CorrectionPreviewError["code"], number> = {
  invalid_request: 400,
  snapshot_required: 409,
  snapshot_stale: 409,
  issue_not_found: 404,
  product_missing: 404,
  variant_missing: 404,
  price_row_missing: 409,
  price_row_ambiguous: 409,
  stock_location_missing: 409,
  stock_location_ambiguous: 409,
  stale_guard_unavailable: 409,
  no_change: 409,
  operation_conflict: 409,
};

const EXECUTION_STATUS: Record<MutationExecutionError["code"], number> = {
  write_disabled: 403,
  feature_required: 403,
  confirmation_missing: 404,
  confirmation_expired: 410,
  confirmation_replay: 409,
  product_missing: 409,
  variant_missing: 409,
  stale_product: 412,
  stale_value: 412,
  stock_location_missing: 409,
  price_row_missing: 409,
  write_rejected: 422,
  preflight_failed: 503,
  // The write may or may not have landed. The merchant is told to re-check, never told it worked.
  mutation_outcome_unknown: 409,
  verification_failed: 409,
  invariant_violation: 409,
  rate_limited: 429,
  store_unavailable: 503,
};

const UNDO_STATUS: Record<UndoPreparationError["code"], number> = {
  operation_missing: 404,
  operation_not_undoable: 409,
  undo_not_available: 409,
  undo_baseline_changed: 409,
  product_missing: 404,
  variant_missing: 404,
  stale_guard_unavailable: 409,
  operation_conflict: 409,
};

/**
 * One sanitized mapping for every failure a correction route can produce. Upstream text, stack
 * traces and provider error codes never reach the merchant or the network.
 */
export function describeCorrectionFailure(error: unknown): { status: number; code: string } {
  if (error instanceof CorrectionPreviewError) {
    return { status: PREVIEW_STATUS[error.code], code: `IKAS_CORRECTION_${error.code.toUpperCase()}` };
  }
  if (error instanceof MutationExecutionError) {
    return { status: EXECUTION_STATUS[error.code], code: `IKAS_CORRECTION_${error.code.toUpperCase()}` };
  }
  if (error instanceof UndoPreparationError) {
    return { status: UNDO_STATUS[error.code], code: `IKAS_CORRECTION_${error.code.toUpperCase()}` };
  }
  if (error instanceof IkasAuthenticationError) {
    return { status: 401, code: "IKAS_LIVE_AUTH_REQUIRED" };
  }
  if (error instanceof MutationOperationStoreError || error instanceof TokenStoreError) {
    return { status: 503, code: "IKAS_CORRECTION_BACKEND_UNAVAILABLE" };
  }
  if (error instanceof IkasUpstreamError) {
    return { status: 502, code: "IKAS_CORRECTION_UPSTREAM_UNAVAILABLE" };
  }
  return { status: 500, code: "IKAS_CORRECTION_FAILED" };
}

export function logCorrectionFailure(event: string, correlationId: string, code: string) {
  // Operator-owned identifiers only: no tenant id, no product data, no token.
  console.error(JSON.stringify({ event, correlationId, outcome: "failure", reason: code }));
}
