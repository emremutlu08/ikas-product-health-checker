import { createHash } from "node:crypto";
import {
  TENANT_DELETED_REDIS_RESULT,
  tenantDeletionKey,
  tenantDeletionMarker,
  validateTenantIdentity,
  type TenantIdentity,
} from "@/lib/lifecycle/tenant-identity";

export type PreparedSkuOperation = {
  version: 1;
  operationId: string;
  kind: "sku_change";
  status: "prepared";
  productId: string;
  variantId: string;
  expectedProductUpdatedAt: string;
  expectedPreviousSku: string | null;
  proposedSku: string;
  createdAt: number;
  expiresAt: number;
};

export type ExecutingSkuOperation = Omit<PreparedSkuOperation, "status"> & {
  status: "executing";
  claimedAt: number;
};

export type SkuOperationSettlement =
  | {
      status: "succeeded";
      completedAt: number;
      verifiedSku: string;
    }
  | {
      status: "rejected";
      completedAt: number;
      reason: "product_missing" | "variant_missing" | "stale_product" | "stale_value";
    }
  | {
      status: "failed_unknown";
      completedAt: number;
      reason: "mutation_outcome_unknown" | "verification_failed";
    };

export type TerminalSkuOperation = Omit<ExecutingSkuOperation, "status"> &
  SkuOperationSettlement;

export type MutationOperation =
  | PreparedSkuOperation
  | ExecutingSkuOperation
  | TerminalSkuOperation;
export type PrepareMutationResult = "prepared" | "already_exists";
export type ClaimMutationResult =
  | { outcome: "claimed"; operation: ExecutingSkuOperation }
  | { outcome: "missing" }
  | { outcome: "expired" }
  | { outcome: "replay" };

export interface MutationOperationStore {
  prepare(tenant: TenantIdentity, operation: PreparedSkuOperation): Promise<PrepareMutationResult>;
  get(tenant: TenantIdentity, operationId: string): Promise<MutationOperation | undefined>;
  claim(tenant: TenantIdentity, operationId: string, claimedAt: number): Promise<ClaimMutationResult>;
  settle(
    tenant: TenantIdentity,
    operationId: string,
    settlement: SkuOperationSettlement,
  ): Promise<boolean>;
}

function operationKey(tenant: TenantIdentity, operationId: string) {
  const validated = validateTenantIdentity(tenant);
  const digest = createHash("sha256")
    .update(`${validated.authorizedAppId}\u0000${validated.merchantId}\u0000${operationId}`, "utf8")
    .digest("base64url");
  return `ikas:mutation-operation:v1:${digest}`;
}

const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const EXECUTION_AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREPARE_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "local stored = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])",
  "if stored then return 1 end",
  "return 0",
].join("\n");
const CLAIM_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 'missing' end",
  "local stored = cjson.decode(raw)",
  "if stored.tenantMarker ~= ARGV[1] then return 'identity_mismatch' end",
  "if stored.operation.status ~= 'prepared' then return 'replay' end",
  "local claimedAt = tonumber(ARGV[2])",
  "if claimedAt >= stored.operation.expiresAt then return 'expired' end",
  "stored.operation.status = 'executing'",
  "stored.operation.claimedAt = claimedAt",
  "redis.call('SET', KEYS[1], cjson.encode(stored), 'PX', ARGV[3])",
  "return cjson.encode(stored.operation)",
].join("\n");
const SETTLE_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local stored = cjson.decode(raw)",
  "if stored.tenantMarker ~= ARGV[1] then return 'identity_mismatch' end",
  "if stored.operation.status ~= 'executing' then return 0 end",
  "local settlement = cjson.decode(ARGV[2])",
  "stored.operation.status = settlement.status",
  "stored.operation.completedAt = settlement.completedAt",
  "if settlement.status == 'succeeded' then stored.operation.verifiedSku = settlement.verifiedSku end",
  "if settlement.status == 'rejected' or settlement.status == 'failed_unknown' then stored.operation.reason = settlement.reason end",
  "redis.call('SET', KEYS[1], cjson.encode(stored), 'KEEPTTL')",
  "return 1",
].join("\n");

type RedisCommand = Array<string | number>;

type StoredMutationOperation = {
  tenantMarker: string;
  operation: MutationOperation;
};

export type RedisRestMutationOperationStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export class MutationOperationStoreError extends Error {
  constructor(readonly code: "configuration" | "backend" | "tenant_deleted" | "identity_mismatch") {
    super(`IKAS_MUTATION_STORE_${code.toUpperCase()}`);
    this.name = "MutationOperationStoreError";
  }
}

function isRedisPayload(value: unknown): value is { result: unknown } {
  return typeof value === "object" && value !== null && "result" in value;
}

function isExecutingSkuOperation(value: unknown): value is ExecutingSkuOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  return (
    operation.version === 1 &&
    typeof operation.operationId === "string" &&
    operation.kind === "sku_change" &&
    operation.status === "executing" &&
    typeof operation.productId === "string" &&
    typeof operation.variantId === "string" &&
    typeof operation.expectedProductUpdatedAt === "string" &&
    (typeof operation.expectedPreviousSku === "string" || operation.expectedPreviousSku === null) &&
    typeof operation.proposedSku === "string" &&
    typeof operation.createdAt === "number" &&
    typeof operation.expiresAt === "number" &&
    typeof operation.claimedAt === "number"
  );
}

export class RedisRestMutationOperationStore {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: RedisRestMutationOperationStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REDIS_REQUEST_TIMEOUT_MS;
    if (!options.url?.trim() || !options.token?.trim()) {
      throw new MutationOperationStoreError("configuration");
    }
    try {
      if (new URL(options.url).protocol !== "https:") throw new Error("insecure");
    } catch {
      throw new MutationOperationStoreError("configuration");
    }
  }

  private async command(command: RedisCommand): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
        cache: "no-store",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new MutationOperationStoreError("backend");
    }
    if (!response.ok) throw new MutationOperationStoreError("backend");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MutationOperationStoreError("backend");
    }
    if (!isRedisPayload(payload) || ("error" in payload && payload.error)) {
      throw new MutationOperationStoreError("backend");
    }
    return payload.result;
  }

  async prepare(tenant: TenantIdentity, operation: PreparedSkuOperation): Promise<PrepareMutationResult> {
    const validated = validateTenantIdentity(tenant);
    const ttlMs = operation.expiresAt - operation.createdAt;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) {
      throw new MutationOperationStoreError("configuration");
    }
    const stored: StoredMutationOperation = {
      tenantMarker: tenantDeletionMarker(validated),
      operation: structuredClone(operation),
    };
    const result = await this.command([
      "EVAL",
      PREPARE_SCRIPT,
      2,
      operationKey(validated, operation.operationId),
      tenantDeletionKey(validated.authorizedAppId),
      JSON.stringify(stored),
      ttlMs,
    ]);
    if (result === 1) return "prepared";
    if (result === 0) return "already_exists";
    if (result === TENANT_DELETED_REDIS_RESULT) {
      throw new MutationOperationStoreError("tenant_deleted");
    }
    throw new MutationOperationStoreError("backend");
  }

  async claim(tenant: TenantIdentity, operationId: string, claimedAt: number): Promise<ClaimMutationResult> {
    const validated = validateTenantIdentity(tenant);
    if (!Number.isSafeInteger(claimedAt) || claimedAt <= 0) {
      throw new MutationOperationStoreError("configuration");
    }
    const result = await this.command([
      "EVAL",
      CLAIM_SCRIPT,
      2,
      operationKey(validated, operationId),
      tenantDeletionKey(validated.authorizedAppId),
      tenantDeletionMarker(validated),
      claimedAt,
      EXECUTION_AUDIT_TTL_MS,
    ]);
    if (result === "missing" || result === "expired" || result === "replay") {
      return { outcome: result };
    }
    if (result === TENANT_DELETED_REDIS_RESULT) {
      throw new MutationOperationStoreError("tenant_deleted");
    }
    if (result === "identity_mismatch") {
      throw new MutationOperationStoreError("identity_mismatch");
    }
    if (typeof result !== "string") throw new MutationOperationStoreError("backend");
    let operation: unknown;
    try {
      operation = JSON.parse(result);
    } catch {
      throw new MutationOperationStoreError("backend");
    }
    if (!isExecutingSkuOperation(operation)) throw new MutationOperationStoreError("backend");
    return { outcome: "claimed", operation };
  }

  async settle(
    tenant: TenantIdentity,
    operationId: string,
    settlement: SkuOperationSettlement,
  ): Promise<boolean> {
    const validated = validateTenantIdentity(tenant);
    const validSucceeded =
      settlement.status === "succeeded" &&
      typeof settlement.verifiedSku === "string" &&
      settlement.verifiedSku.length > 0 &&
      settlement.verifiedSku.length <= 128;
    const validRejected =
      settlement.status === "rejected" &&
      ["product_missing", "variant_missing", "stale_product", "stale_value"].includes(
        settlement.reason,
      );
    const validFailedUnknown =
      settlement.status === "failed_unknown" &&
      ["mutation_outcome_unknown", "verification_failed"].includes(settlement.reason);
    if (
      !Number.isSafeInteger(settlement.completedAt) ||
      settlement.completedAt <= 0 ||
      (!validSucceeded && !validRejected && !validFailedUnknown)
    ) {
      throw new MutationOperationStoreError("configuration");
    }
    const result = await this.command([
      "EVAL",
      SETTLE_SCRIPT,
      2,
      operationKey(validated, operationId),
      tenantDeletionKey(validated.authorizedAppId),
      tenantDeletionMarker(validated),
      JSON.stringify(settlement),
    ]);
    if (result === 1) return true;
    if (result === 0) return false;
    if (result === TENANT_DELETED_REDIS_RESULT) {
      throw new MutationOperationStoreError("tenant_deleted");
    }
    if (result === "identity_mismatch") {
      throw new MutationOperationStoreError("identity_mismatch");
    }
    throw new MutationOperationStoreError("backend");
  }
}

export class MemoryMutationOperationStore implements MutationOperationStore {
  private readonly records = new Map<string, MutationOperation>();

  async prepare(tenant: TenantIdentity, operation: PreparedSkuOperation): Promise<PrepareMutationResult> {
    const key = operationKey(tenant, operation.operationId);
    if (this.records.has(key)) return "already_exists";
    this.records.set(key, structuredClone(operation));
    return "prepared";
  }

  async get(tenant: TenantIdentity, operationId: string): Promise<MutationOperation | undefined> {
    const record = this.records.get(operationKey(tenant, operationId));
    return record ? structuredClone(record) : undefined;
  }

  async claim(tenant: TenantIdentity, operationId: string, claimedAt: number): Promise<ClaimMutationResult> {
    const key = operationKey(tenant, operationId);
    const record = this.records.get(key);
    if (!record) return { outcome: "missing" };
    if (record.status !== "prepared") return { outcome: "replay" };
    if (claimedAt >= record.expiresAt) return { outcome: "expired" };

    const operation: ExecutingSkuOperation = {
      ...record,
      status: "executing",
      claimedAt,
    };
    this.records.set(key, operation);
    return { outcome: "claimed", operation: structuredClone(operation) };
  }

  async settle(
    tenant: TenantIdentity,
    operationId: string,
    settlement: SkuOperationSettlement,
  ): Promise<boolean> {
    const key = operationKey(tenant, operationId);
    const record = this.records.get(key);
    if (!record || record.status !== "executing") return false;
    this.records.set(key, { ...record, ...settlement });
    return true;
  }
}
