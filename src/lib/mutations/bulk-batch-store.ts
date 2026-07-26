import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { TOKEN_STORE_ENV_KEYS } from "@/lib/ikas/token-store";
import {
  TENANT_DELETED_REDIS_RESULT,
  TenantIdentityError,
  tenantDeletionKey,
  tenantDeletionMarker,
  validateTenantIdentity,
  type DeleteResult,
  type TenantIdentity,
} from "@/lib/lifecycle/tenant-identity";

/**
 * The durable record of a bulk correction.
 *
 * A batch owns no mutation logic of its own: each ready item is an ordinary confirmed operation,
 * so per-item idempotency, atomic claim, replay rejection, read-back and audit all come from the
 * single-correction machinery. What lives here is the part a batch adds — the plan the merchant
 * saw, a one-time confirmation bound to that exact plan, and a cancel flag the executor honours
 * between chunks.
 */

export const MAX_BULK_ITEMS = 50;
export const BULK_CONFIRMATION_TTL_MS = 15 * 60 * 1000;
export const BULK_BATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BATCH_PAYLOAD_BYTES = 32_768;
export const BATCH_INDEX_LIMIT = 200;

const BATCH_KEY_PREFIX = "ikas:mutation-batch:v1:";
const BATCH_INDEX_PREFIX = "ikas:mutation-batch-index:v1:";
const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const DELETE_CHUNK_SIZE = 100;

export const BULK_ITEM_PLAN_STATES = ["ready", "stale", "invalid", "skipped"] as const;
export type BulkItemPlanState = (typeof BULK_ITEM_PLAN_STATES)[number];

export const BULK_BATCH_STATUSES = [
  "planned",
  "confirmed",
  "running",
  "completed",
  "cancelled",
] as const;
export type BulkBatchStatus = (typeof BULK_BATCH_STATUSES)[number];

const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);

const bulkPlanItemSchema = z.strictObject({
  index: z.number().int().nonnegative().max(MAX_BULK_ITEMS),
  productId: identifier,
  variantId: identifier,
  state: z.enum(BULK_ITEM_PLAN_STATES),
  operationId: identifier.optional(),
  /** A sanitized code, never provider text. */
  reason: z.string().min(1).max(64).optional(),
});

export type BulkPlanItem = z.infer<typeof bulkPlanItemSchema>;

const bulkBatchSchema = z.strictObject({
  version: z.literal(1),
  batchId: identifier,
  status: z.enum(BULK_BATCH_STATUSES),
  planHash: z.string().length(43),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  items: z.array(bulkPlanItemSchema).min(1).max(MAX_BULK_ITEMS),
});

export type BulkBatchRecord = z.infer<typeof bulkBatchSchema>;

export type BulkBatchStoreErrorCode =
  | "configuration"
  | "backend"
  | "corrupt_record"
  | "tenant_deleted"
  | "identity_mismatch";

export class BulkBatchStoreError extends Error {
  constructor(readonly code: BulkBatchStoreErrorCode) {
    super(`IKAS_BULK_BATCH_${code.toUpperCase()}`);
    this.name = "BulkBatchStoreError";
  }
}

export type BulkConfirmOutcome =
  | "confirmed"
  | "missing"
  | "expired"
  | "replay"
  | "cancelled"
  | "plan_mismatch";

export interface BulkBatchStore {
  create(tenant: TenantIdentity, record: BulkBatchRecord): Promise<"created" | "already_exists">;
  get(tenant: TenantIdentity, batchId: string): Promise<BulkBatchRecord | undefined>;
  confirm(
    tenant: TenantIdentity,
    batchId: string,
    planHash: string,
    now: number,
  ): Promise<BulkConfirmOutcome>;
  setStatus(
    tenant: TenantIdentity,
    batchId: string,
    status: Extract<BulkBatchStatus, "running" | "completed" | "cancelled">,
  ): Promise<boolean>;
  listRecent(tenant: TenantIdentity, limit: number): Promise<string[]>;
  deleteTenant(tenant: TenantIdentity): Promise<DeleteResult>;
}

/**
 * Binds a confirmation to the exact plan the merchant was shown. Re-planning the same requests
 * after the catalog moved produces a different hash, so an old confirmation cannot execute a new
 * plan.
 */
export function computePlanHash(batchId: string, items: readonly BulkPlanItem[]): string {
  const canonical = items
    .map((item) => [item.index, item.state, item.productId, item.variantId, item.operationId ?? ""].join(":"))
    .join("|");
  return createHash("sha256").update(`${batchId}\n${canonical}`, "utf8").digest("base64url");
}

function batchKey(tenant: TenantIdentity, batchId: string) {
  const digest = createHash("sha256")
    .update(`${tenant.authorizedAppId} ${tenant.merchantId} ${batchId}`, "utf8")
    .digest("base64url");
  return `${BATCH_KEY_PREFIX}${digest}`;
}

function batchIndexKey(tenant: TenantIdentity) {
  const digest = createHash("sha256")
    .update(`${tenant.authorizedAppId} ${tenant.merchantId}`, "utf8")
    .digest("base64url");
  return `${BATCH_INDEX_PREFIX}${digest}`;
}

function validateTenant(tenant: TenantIdentity): TenantIdentity {
  try {
    return validateTenantIdentity(tenant);
  } catch (error) {
    if (error instanceof TenantIdentityError) throw new BulkBatchStoreError("configuration");
    throw error;
  }
}

function serialize(record: BulkBatchRecord): string {
  const parsed = bulkBatchSchema.safeParse(record);
  if (!parsed.success) throw new BulkBatchStoreError("configuration");
  if (parsed.data.expiresAt <= parsed.data.createdAt) throw new BulkBatchStoreError("configuration");
  const serialized = JSON.stringify(parsed.data);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BATCH_PAYLOAD_BYTES) {
    throw new BulkBatchStoreError("configuration");
  }
  return serialized;
}

function deserialize(raw: unknown, status: unknown): BulkBatchRecord {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_BATCH_PAYLOAD_BYTES) {
    throw new BulkBatchStoreError("corrupt_record");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BulkBatchStoreError("corrupt_record");
  }
  const parsed = bulkBatchSchema.safeParse(value);
  if (!parsed.success) throw new BulkBatchStoreError("corrupt_record");
  if (typeof status !== "string" || !BULK_BATCH_STATUSES.includes(status as BulkBatchStatus)) {
    throw new BulkBatchStoreError("corrupt_record");
  }
  // The live status field is authoritative; the serialized plan keeps the shape it was created in.
  return { ...parsed.data, status: status as BulkBatchStatus };
}

const CREATE_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end",
  "redis.call('HSET', KEYS[1], 'tenantMarker', ARGV[1], 'status', 'planned', 'planHash', ARGV[2], 'expiresAt', ARGV[3], 'plan', ARGV[4])",
  "redis.call('PEXPIRE', KEYS[1], ARGV[5])",
  "redis.call('ZADD', KEYS[3], ARGV[6], ARGV[7])",
  "local overflow = redis.call('ZCARD', KEYS[3]) - tonumber(ARGV[8])",
  "if overflow > 0 then redis.call('ZREMRANGEBYRANK', KEYS[3], 0, overflow - 1) end",
  "redis.call('PEXPIRE', KEYS[3], ARGV[5])",
  "return 1",
].join("\n");

/** One atomic decision: the plan must match, the window must be open, and it happens once. */
const CONFIRM_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return {'${TENANT_DELETED_REDIS_RESULT}'} end`,
  "local marker = redis.call('HGET', KEYS[1], 'tenantMarker')",
  "if not marker then return {'missing'} end",
  "if marker ~= ARGV[1] then return {'identity_mismatch'} end",
  "local status = redis.call('HGET', KEYS[1], 'status')",
  "if status == 'cancelled' then return {'cancelled'} end",
  "if status ~= 'planned' then return {'replay'} end",
  "if redis.call('HGET', KEYS[1], 'planHash') ~= ARGV[2] then return {'plan_mismatch'} end",
  "if tonumber(ARGV[3]) >= tonumber(redis.call('HGET', KEYS[1], 'expiresAt')) then return {'expired'} end",
  "redis.call('HSET', KEYS[1], 'status', 'confirmed')",
  "redis.call('PEXPIRE', KEYS[1], ARGV[4])",
  "return {'confirmed'}",
].join("\n");

const STATUS_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return {'${TENANT_DELETED_REDIS_RESULT}'} end`,
  "local marker = redis.call('HGET', KEYS[1], 'tenantMarker')",
  "if not marker then return {'missing'} end",
  "if marker ~= ARGV[1] then return {'identity_mismatch'} end",
  "local status = redis.call('HGET', KEYS[1], 'status')",
  "if status == 'planned' and ARGV[2] ~= 'cancelled' then return {'invalid_transition'} end",
  "if status == 'completed' or status == 'cancelled' then return {'invalid_transition'} end",
  "redis.call('HSET', KEYS[1], 'status', ARGV[2])",
  "redis.call('PEXPIRE', KEYS[1], ARGV[3])",
  "return {'ok'}",
].join("\n");

const GET_SCRIPT = [
  "local marker = redis.call('HGET', KEYS[1], 'tenantMarker')",
  "if not marker then return {'missing'} end",
  "if marker ~= ARGV[1] then return {'identity_mismatch'} end",
  "return {'found', redis.call('HGET', KEYS[1], 'status'), redis.call('HGET', KEYS[1], 'plan')}",
].join("\n");

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RedisBulkBatchStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export class RedisBulkBatchStore implements BulkBatchStore {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: RedisBulkBatchStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REDIS_REQUEST_TIMEOUT_MS;
    if (!options.url?.trim() || !options.token?.trim()) throw new BulkBatchStoreError("configuration");
    try {
      if (new URL(options.url).protocol !== "https:") throw new Error("insecure endpoint");
    } catch {
      throw new BulkBatchStoreError("configuration");
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
      throw new BulkBatchStoreError("backend");
    }
    if (!response.ok) throw new BulkBatchStoreError("backend");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BulkBatchStoreError("backend");
    }
    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new BulkBatchStoreError("backend");
    }
    return payload.result;
  }

  private static row(result: unknown): readonly unknown[] {
    if (!Array.isArray(result) || result.length === 0) throw new BulkBatchStoreError("backend");
    if (result[0] === TENANT_DELETED_REDIS_RESULT) throw new BulkBatchStoreError("tenant_deleted");
    if (result[0] === "identity_mismatch") throw new BulkBatchStoreError("identity_mismatch");
    return result;
  }

  async create(tenant: TenantIdentity, record: BulkBatchRecord) {
    const validated = validateTenant(tenant);
    const serialized = serialize(record);
    const result = await this.command([
      "EVAL",
      CREATE_SCRIPT,
      3,
      batchKey(validated, record.batchId),
      tenantDeletionKey(validated.authorizedAppId),
      batchIndexKey(validated),
      tenantDeletionMarker(validated),
      record.planHash,
      record.expiresAt,
      serialized,
      BULK_BATCH_TTL_MS,
      record.createdAt,
      record.batchId,
      BATCH_INDEX_LIMIT,
    ]);
    if (result === 1) return "created" as const;
    if (result === 0) return "already_exists" as const;
    if (result === TENANT_DELETED_REDIS_RESULT) throw new BulkBatchStoreError("tenant_deleted");
    throw new BulkBatchStoreError("backend");
  }

  async get(tenant: TenantIdentity, batchId: string) {
    const validated = validateTenant(tenant);
    const row = RedisBulkBatchStore.row(
      await this.command([
        "EVAL",
        GET_SCRIPT,
        1,
        batchKey(validated, batchId),
        tenantDeletionMarker(validated),
      ]),
    );
    if (row[0] === "missing") return undefined;
    if (row[0] !== "found") throw new BulkBatchStoreError("backend");
    return deserialize(row[2], row[1]);
  }

  async confirm(tenant: TenantIdentity, batchId: string, planHash: string, now: number) {
    const validated = validateTenant(tenant);
    const row = RedisBulkBatchStore.row(
      await this.command([
        "EVAL",
        CONFIRM_SCRIPT,
        2,
        batchKey(validated, batchId),
        tenantDeletionKey(validated.authorizedAppId),
        tenantDeletionMarker(validated),
        planHash,
        now,
        BULK_BATCH_TTL_MS,
      ]),
    );
    const [outcome] = row;
    if (
      outcome === "confirmed" ||
      outcome === "missing" ||
      outcome === "expired" ||
      outcome === "replay" ||
      outcome === "cancelled" ||
      outcome === "plan_mismatch"
    ) {
      return outcome;
    }
    throw new BulkBatchStoreError("backend");
  }

  async setStatus(
    tenant: TenantIdentity,
    batchId: string,
    status: "running" | "completed" | "cancelled",
  ) {
    const validated = validateTenant(tenant);
    const row = RedisBulkBatchStore.row(
      await this.command([
        "EVAL",
        STATUS_SCRIPT,
        2,
        batchKey(validated, batchId),
        tenantDeletionKey(validated.authorizedAppId),
        tenantDeletionMarker(validated),
        status,
        BULK_BATCH_TTL_MS,
      ]),
    );
    return row[0] === "ok";
  }

  async listRecent(tenant: TenantIdentity, limit: number) {
    const validated = validateTenant(tenant);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > BATCH_INDEX_LIMIT) {
      throw new BulkBatchStoreError("configuration");
    }
    const result = await this.command(["ZRANGE", batchIndexKey(validated), 0, limit - 1, "REV"]);
    if (!Array.isArray(result) || result.some((entry) => typeof entry !== "string")) {
      throw new BulkBatchStoreError("backend");
    }
    return result as string[];
  }

  async deleteTenant(tenant: TenantIdentity): Promise<DeleteResult> {
    const validated = validateTenant(tenant);
    const batchIds = await this.listRecent(validated, BATCH_INDEX_LIMIT);
    let removed = 0;
    for (let offset = 0; offset < batchIds.length; offset += DELETE_CHUNK_SIZE) {
      const keys = batchIds
        .slice(offset, offset + DELETE_CHUNK_SIZE)
        .map((batchId) => batchKey(validated, batchId));
      const result = await this.command(["DEL", ...keys]);
      if (typeof result !== "number") throw new BulkBatchStoreError("backend");
      removed += result;
    }
    const indexResult = await this.command(["DEL", batchIndexKey(validated)]);
    if (typeof indexResult !== "number") throw new BulkBatchStoreError("backend");
    return removed + indexResult > 0 ? "deleted" : "absent";
  }
}

export class MemoryBulkBatchStore implements BulkBatchStore {
  private readonly records = new Map<string, { marker: string; record: BulkBatchRecord }>();
  private readonly index = new Map<string, Array<{ batchId: string; createdAt: number }>>();

  async create(tenant: TenantIdentity, record: BulkBatchRecord) {
    const validated = validateTenant(tenant);
    const serialized = serialize(record);
    const key = batchKey(validated, record.batchId);
    if (this.records.has(key)) return "already_exists" as const;
    this.records.set(key, {
      marker: tenantDeletionMarker(validated),
      record: deserialize(serialized, record.status),
    });
    const entries = this.index.get(batchIndexKey(validated)) ?? [];
    entries.push({ batchId: record.batchId, createdAt: record.createdAt });
    entries.sort((left, right) => left.createdAt - right.createdAt);
    this.index.set(batchIndexKey(validated), entries.slice(-BATCH_INDEX_LIMIT));
    return "created" as const;
  }

  private read(tenant: TenantIdentity, batchId: string) {
    const stored = this.records.get(batchKey(tenant, batchId));
    if (!stored) return undefined;
    if (stored.marker !== tenantDeletionMarker(tenant)) {
      throw new BulkBatchStoreError("identity_mismatch");
    }
    return stored;
  }

  async get(tenant: TenantIdentity, batchId: string) {
    const stored = this.read(validateTenant(tenant), batchId);
    return stored ? structuredClone(stored.record) : undefined;
  }

  async confirm(tenant: TenantIdentity, batchId: string, planHash: string, now: number) {
    const stored = this.read(validateTenant(tenant), batchId);
    if (!stored) return "missing" as const;
    if (stored.record.status === "cancelled") return "cancelled" as const;
    if (stored.record.status !== "planned") return "replay" as const;
    if (stored.record.planHash !== planHash) return "plan_mismatch" as const;
    if (now >= stored.record.expiresAt) return "expired" as const;
    stored.record.status = "confirmed";
    return "confirmed" as const;
  }

  async setStatus(
    tenant: TenantIdentity,
    batchId: string,
    status: "running" | "completed" | "cancelled",
  ) {
    const stored = this.read(validateTenant(tenant), batchId);
    if (!stored) return false;
    if (stored.record.status === "planned" && status !== "cancelled") return false;
    if (stored.record.status === "completed" || stored.record.status === "cancelled") return false;
    stored.record.status = status;
    return true;
  }

  async listRecent(tenant: TenantIdentity, limit: number) {
    const validated = validateTenant(tenant);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > BATCH_INDEX_LIMIT) {
      throw new BulkBatchStoreError("configuration");
    }
    return (this.index.get(batchIndexKey(validated)) ?? [])
      .slice()
      .reverse()
      .slice(0, limit)
      .map((entry) => entry.batchId);
  }

  async deleteTenant(tenant: TenantIdentity): Promise<DeleteResult> {
    const validated = validateTenant(tenant);
    const entries = this.index.get(batchIndexKey(validated)) ?? [];
    let removed = this.index.delete(batchIndexKey(validated)) ? 1 : 0;
    for (const entry of entries) {
      if (this.records.delete(batchKey(validated, entry.batchId))) removed += 1;
    }
    return removed > 0 ? "deleted" : "absent";
  }
}

function environmentValue(env: Environment, key: string) {
  return env[key]?.trim() || undefined;
}

function readCredentialPair(env: Environment, keys: readonly [string, string]) {
  const url = environmentValue(env, keys[0]);
  const token = environmentValue(env, keys[1]);
  if (!url && !token) return undefined;
  if (!url || !token) throw new BulkBatchStoreError("configuration");
  return { url, token };
}

export function createBulkBatchStore({
  env = process.env,
  fetchImpl = fetch,
}: { env?: Environment; fetchImpl?: typeof fetch } = {}): BulkBatchStore {
  const environment = environmentValue(env, "NODE_ENV");
  const driver = environmentValue(env, "IKAS_MUTATION_STORE_DRIVER");
  if (driver && !["redis", "memory"].includes(driver)) throw new BulkBatchStoreError("configuration");
  if (driver === "memory") {
    if (environment !== "development" && environment !== "test") {
      throw new BulkBatchStoreError("configuration");
    }
    return new MemoryBulkBatchStore();
  }
  const credentials =
    readCredentialPair(env, TOKEN_STORE_ENV_KEYS.current) ??
    readCredentialPair(env, TOKEN_STORE_ENV_KEYS.legacyVercelKv);
  if (!credentials) throw new BulkBatchStoreError("configuration");
  return new RedisBulkBatchStore({ ...credentials, fetchImpl });
}

let configuredBatchStore: BulkBatchStore | undefined;

export function bulkBatchStore(): BulkBatchStore {
  configuredBatchStore ??= createBulkBatchStore();
  return configuredBatchStore;
}

export function resetBulkBatchStoreForTests() {
  configuredBatchStore = undefined;
}
