import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TOKEN_STORE_ENV_KEYS } from "@/lib/ikas/token-store";
import {
  TENANT_DELETED_REDIS_RESULT,
  TenantIdentityError,
  tenantDeletionKey,
  validateTenantIdentity,
  type DeleteResult,
  type TenantIdentity,
} from "@/lib/lifecycle/tenant-identity";
import type { AlertEntryState, AlertSide, AlertStateMap } from "./low-stock-alerts";

/**
 * Durable state for low-stock alerting: what the merchant was last told, and what has already been
 * sent.
 *
 * Both stores are tenant-keyed by digest, hold no product data beyond identifiers, and check the
 * uninstall deletion barrier inside the same Lua transaction as their write — so a scan that was
 * already in flight when a merchant uninstalled cannot recreate tenant state or send them mail.
 */

export type AlertStoreErrorCode = "configuration" | "backend" | "corrupt_record" | "tenant_deleted";

export class AlertStoreError extends Error {
  constructor(readonly code: AlertStoreErrorCode) {
    super(`IKAS_ALERT_STORE_${code.toUpperCase()}`);
    this.name = "AlertStoreError";
  }
}

export type AlertStateRecord = {
  state: AlertStateMap;
  lastScanId?: string;
};

export interface LowStockAlertStore {
  read(tenant: TenantIdentity): Promise<AlertStateRecord>;
  write(tenant: TenantIdentity, record: AlertStateRecord): Promise<void>;
  deleteTenant(tenant: TenantIdentity): Promise<DeleteResult>;
}

export type OutboxClaimOutcome = "claimed" | "already_sent" | "in_flight" | "backoff" | "exhausted";

/** The attempt number comes back so the caller can grow its backoff instead of guessing one. */
export type OutboxClaim = { outcome: OutboxClaimOutcome; attempts: number };

export interface AlertOutboxStore {
  claim(
    tenant: TenantIdentity,
    idempotencyKey: string,
    now: number,
    leaseMs: number,
  ): Promise<OutboxClaim>;
  markSent(tenant: TenantIdentity, idempotencyKey: string): Promise<void>;
  markFailed(
    tenant: TenantIdentity,
    idempotencyKey: string,
    nextAttemptAt: number,
  ): Promise<void>;
  deleteTenant(tenant: TenantIdentity): Promise<DeleteResult>;
}

const STATE_KEY_PREFIX = "ikas:low-stock-alert:v1:";
const OUTBOX_KEY_PREFIX = "ikas:alert-outbox:v1:";
const REDIS_REQUEST_TIMEOUT_MS = 5_000;

export const MAX_ALERT_STATE_BYTES = 262_144;
export const ALERT_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OUTBOX_ENTRIES = 5_000;
export const MAX_DELIVERY_ATTEMPTS = 4;

function tenantDigest(tenant: TenantIdentity) {
  return createHash("sha256")
    .update(`${tenant.authorizedAppId} ${tenant.merchantId}`, "utf8")
    .digest("base64url");
}

function stateKey(tenant: TenantIdentity) {
  return `${STATE_KEY_PREFIX}${tenantDigest(tenant)}`;
}

function outboxKey(tenant: TenantIdentity) {
  return `${OUTBOX_KEY_PREFIX}${tenantDigest(tenant)}`;
}

function outboxField(idempotencyKey: string) {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("base64url");
}

function validateTenant(tenant: TenantIdentity): TenantIdentity {
  try {
    return validateTenantIdentity(tenant);
  } catch (error) {
    if (error instanceof TenantIdentityError) throw new AlertStoreError("configuration");
    throw error;
  }
}

const SIDES: readonly AlertSide[] = ["below", "above"];

function parseEntry(value: unknown): AlertEntryState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const positiveInteger = (candidate: unknown) =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;

  if (
    typeof entry.side !== "string" ||
    !SIDES.includes(entry.side as AlertSide) ||
    !positiveInteger(entry.firstSeen) ||
    !positiveInteger(entry.lastSeen)
  ) {
    return undefined;
  }
  if (entry.lastNotifiedAt !== undefined && !positiveInteger(entry.lastNotifiedAt)) return undefined;
  if (
    entry.lastNotifiedSide !== undefined &&
    (typeof entry.lastNotifiedSide !== "string" || !SIDES.includes(entry.lastNotifiedSide as AlertSide))
  ) {
    return undefined;
  }

  return {
    side: entry.side as AlertSide,
    firstSeen: entry.firstSeen as number,
    lastSeen: entry.lastSeen as number,
    ...(entry.lastNotifiedAt !== undefined ? { lastNotifiedAt: entry.lastNotifiedAt as number } : {}),
    ...(entry.lastNotifiedSide !== undefined
      ? { lastNotifiedSide: entry.lastNotifiedSide as AlertSide }
      : {}),
  };
}

/** Fail-closed: one unparseable entry invalidates the record rather than silently changing state. */
export function parseAlertStateRecord(raw: unknown): AlertStateRecord {
  if (typeof raw !== "string") throw new AlertStoreError("corrupt_record");
  if (Buffer.byteLength(raw, "utf8") > MAX_ALERT_STATE_BYTES) {
    throw new AlertStoreError("corrupt_record");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AlertStoreError("corrupt_record");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AlertStoreError("corrupt_record");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new AlertStoreError("corrupt_record");
  if (record.lastScanId !== undefined && typeof record.lastScanId !== "string") {
    throw new AlertStoreError("corrupt_record");
  }
  if (typeof record.state !== "object" || record.state === null || Array.isArray(record.state)) {
    throw new AlertStoreError("corrupt_record");
  }

  const state: AlertStateMap = {};
  for (const [key, entry] of Object.entries(record.state as Record<string, unknown>)) {
    const parsed = parseEntry(entry);
    if (!parsed) throw new AlertStoreError("corrupt_record");
    state[key] = parsed;
  }
  return { state, ...(record.lastScanId ? { lastScanId: record.lastScanId } : {}) };
}

export function serializeAlertStateRecord(record: AlertStateRecord): string {
  const serialized = JSON.stringify({
    version: 1,
    ...(record.lastScanId ? { lastScanId: record.lastScanId } : {}),
    state: record.state,
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_ALERT_STATE_BYTES) {
    throw new AlertStoreError("configuration");
  }
  return serialized;
}

const STATE_WRITE_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])",
  "return 1",
].join("\n");

/**
 * One atomic delivery decision. `sent` is terminal, an in-flight lease blocks a concurrent worker,
 * and a failed attempt only becomes claimable again after its backoff and under the attempt cap.
 */
const OUTBOX_CLAIM_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "local raw = redis.call('HGET', KEYS[1], ARGV[1])",
  "local now = tonumber(ARGV[2])",
  "local leaseUntil = now + tonumber(ARGV[3])",
  "if not raw then",
  "  if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then redis.call('DEL', KEYS[1]) end",
  "  redis.call('HSET', KEYS[1], ARGV[1], '1|' .. leaseUntil .. '|1|0')",
  "  redis.call('PEXPIRE', KEYS[1], ARGV[5])",
  "  return {'claimed', 1}",
  "end",
  "local status, lease, attempts, nextAttemptAt = string.match(raw, '(%d+)|(%d+)|(%d+)|(%d+)')",
  "if not status then return {'exhausted', 0} end",
  "if status == '2' then return {'already_sent', tonumber(attempts)} end",
  "if status == '1' and now < tonumber(lease) then return {'in_flight', tonumber(attempts)} end",
  "if tonumber(attempts) >= tonumber(ARGV[6]) then return {'exhausted', tonumber(attempts)} end",
  "if status == '3' and now < tonumber(nextAttemptAt) then return {'backoff', tonumber(attempts)} end",
  "redis.call('HSET', KEYS[1], ARGV[1], '1|' .. leaseUntil .. '|' .. (tonumber(attempts) + 1) .. '|0')",
  "redis.call('PEXPIRE', KEYS[1], ARGV[5])",
  "return {'claimed', tonumber(attempts) + 1}",
].join("\n");

const OUTBOX_SETTLE_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "local raw = redis.call('HGET', KEYS[1], ARGV[1])",
  "if not raw then return 0 end",
  "local status, lease, attempts, nextAttemptAt = string.match(raw, '(%d+)|(%d+)|(%d+)|(%d+)')",
  "redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. '|0|' .. attempts .. '|' .. ARGV[3])",
  "redis.call('PEXPIRE', KEYS[1], ARGV[4])",
  "return 1",
].join("\n");

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

export type RedisAlertStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RedisAlertBackend {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly url: string,
    private readonly token: string,
    fetchImpl: typeof fetch = fetch,
    requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS,
  ) {
    if (!url?.trim() || !token?.trim()) throw new AlertStoreError("configuration");
    try {
      if (new URL(url).protocol !== "https:") throw new Error("insecure endpoint");
    } catch {
      throw new AlertStoreError("configuration");
    }
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async command(command: RedisCommand): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
        cache: "no-store",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new AlertStoreError("backend");
    }
    if (!response.ok) throw new AlertStoreError("backend");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AlertStoreError("backend");
    }
    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new AlertStoreError("backend");
    }
    return payload.result;
  }
}

export class RedisLowStockAlertStore implements LowStockAlertStore {
  private readonly backend: RedisAlertBackend;

  constructor({ url, token, fetchImpl, requestTimeoutMs }: RedisAlertStoreOptions) {
    this.backend = new RedisAlertBackend(url, token, fetchImpl, requestTimeoutMs);
  }

  async read(tenant: TenantIdentity): Promise<AlertStateRecord> {
    const validated = validateTenant(tenant);
    const raw = await this.backend.command(["GET", stateKey(validated)]);
    if (raw === null) return { state: {} };
    return parseAlertStateRecord(raw);
  }

  async write(tenant: TenantIdentity, record: AlertStateRecord): Promise<void> {
    const validated = validateTenant(tenant);
    const result = await this.backend.command([
      "EVAL",
      STATE_WRITE_SCRIPT,
      2,
      stateKey(validated),
      tenantDeletionKey(validated.authorizedAppId),
      serializeAlertStateRecord(record),
      ALERT_STATE_TTL_MS,
    ]);
    if (result === TENANT_DELETED_REDIS_RESULT) throw new AlertStoreError("tenant_deleted");
    if (result !== 1) throw new AlertStoreError("backend");
  }

  async deleteTenant(tenant: TenantIdentity): Promise<DeleteResult> {
    const validated = validateTenant(tenant);
    const result = await this.backend.command(["DEL", stateKey(validated)]);
    if (result !== 0 && result !== 1) throw new AlertStoreError("backend");
    return result === 1 ? "deleted" : "absent";
  }
}

export class RedisAlertOutboxStore implements AlertOutboxStore {
  private readonly backend: RedisAlertBackend;

  constructor({ url, token, fetchImpl, requestTimeoutMs }: RedisAlertStoreOptions) {
    this.backend = new RedisAlertBackend(url, token, fetchImpl, requestTimeoutMs);
  }

  async claim(
    tenant: TenantIdentity,
    idempotencyKey: string,
    now: number,
    leaseMs: number,
  ): Promise<OutboxClaim> {
    const validated = validateTenant(tenant);
    const result = await this.backend.command([
      "EVAL",
      OUTBOX_CLAIM_SCRIPT,
      2,
      outboxKey(validated),
      tenantDeletionKey(validated.authorizedAppId),
      outboxField(idempotencyKey),
      now,
      leaseMs,
      MAX_OUTBOX_ENTRIES,
      OUTBOX_TTL_MS,
      MAX_DELIVERY_ATTEMPTS,
    ]);
    if (result === TENANT_DELETED_REDIS_RESULT) throw new AlertStoreError("tenant_deleted");
    if (!Array.isArray(result) || result.length !== 2) throw new AlertStoreError("backend");
    const [outcome, attempts] = result as [unknown, unknown];
    if (
      typeof attempts !== "number" ||
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      (outcome !== "claimed" &&
        outcome !== "already_sent" &&
        outcome !== "in_flight" &&
        outcome !== "backoff" &&
        outcome !== "exhausted")
    ) {
      throw new AlertStoreError("backend");
    }
    return { outcome, attempts };
  }

  private async settle(
    tenant: TenantIdentity,
    idempotencyKey: string,
    status: "2" | "3",
    nextAttemptAt: number,
  ) {
    const validated = validateTenant(tenant);
    const result = await this.backend.command([
      "EVAL",
      OUTBOX_SETTLE_SCRIPT,
      2,
      outboxKey(validated),
      tenantDeletionKey(validated.authorizedAppId),
      outboxField(idempotencyKey),
      status,
      Math.max(0, Math.trunc(nextAttemptAt)),
      OUTBOX_TTL_MS,
    ]);
    if (result === TENANT_DELETED_REDIS_RESULT) throw new AlertStoreError("tenant_deleted");
    if (result !== 1 && result !== 0) throw new AlertStoreError("backend");
  }

  async markSent(tenant: TenantIdentity, idempotencyKey: string) {
    await this.settle(tenant, idempotencyKey, "2", 0);
  }

  async markFailed(tenant: TenantIdentity, idempotencyKey: string, nextAttemptAt: number) {
    await this.settle(tenant, idempotencyKey, "3", nextAttemptAt);
  }

  async deleteTenant(tenant: TenantIdentity): Promise<DeleteResult> {
    const validated = validateTenant(tenant);
    const result = await this.backend.command(["DEL", outboxKey(validated)]);
    if (result !== 0 && result !== 1) throw new AlertStoreError("backend");
    return result === 1 ? "deleted" : "absent";
  }
}

export class MemoryLowStockAlertStore implements LowStockAlertStore {
  private readonly records = new Map<string, string>();

  async read(tenant: TenantIdentity): Promise<AlertStateRecord> {
    const raw = this.records.get(stateKey(validateTenant(tenant)));
    return raw === undefined ? { state: {} } : parseAlertStateRecord(raw);
  }

  async write(tenant: TenantIdentity, record: AlertStateRecord): Promise<void> {
    this.records.set(stateKey(validateTenant(tenant)), serializeAlertStateRecord(record));
  }

  async deleteTenant(tenant: TenantIdentity): Promise<DeleteResult> {
    return this.records.delete(stateKey(validateTenant(tenant))) ? "deleted" : "absent";
  }
}

type MemoryOutboxEntry = { status: 1 | 2 | 3; leaseUntil: number; attempts: number; nextAttemptAt: number };

export class MemoryAlertOutboxStore implements AlertOutboxStore {
  private readonly records = new Map<string, Map<string, MemoryOutboxEntry>>();

  private bucket(tenant: TenantIdentity) {
    const key = outboxKey(validateTenant(tenant));
    let bucket = this.records.get(key);
    if (!bucket) {
      bucket = new Map();
      this.records.set(key, bucket);
    }
    return bucket;
  }

  async claim(
    tenant: TenantIdentity,
    idempotencyKey: string,
    now: number,
    leaseMs: number,
  ): Promise<OutboxClaim> {
    const bucket = this.bucket(tenant);
    const field = outboxField(idempotencyKey);
    const entry = bucket.get(field);
    if (!entry) {
      bucket.set(field, { status: 1, leaseUntil: now + leaseMs, attempts: 1, nextAttemptAt: 0 });
      return { outcome: "claimed", attempts: 1 };
    }
    if (entry.status === 2) return { outcome: "already_sent", attempts: entry.attempts };
    if (entry.status === 1 && now < entry.leaseUntil) {
      return { outcome: "in_flight", attempts: entry.attempts };
    }
    if (entry.attempts >= MAX_DELIVERY_ATTEMPTS) {
      return { outcome: "exhausted", attempts: entry.attempts };
    }
    if (entry.status === 3 && now < entry.nextAttemptAt) {
      return { outcome: "backoff", attempts: entry.attempts };
    }
    const attempts = entry.attempts + 1;
    bucket.set(field, { status: 1, leaseUntil: now + leaseMs, attempts, nextAttemptAt: 0 });
    return { outcome: "claimed", attempts };
  }

  async markSent(tenant: TenantIdentity, idempotencyKey: string) {
    const entry = this.bucket(tenant).get(outboxField(idempotencyKey));
    if (entry) entry.status = 2;
  }

  async markFailed(tenant: TenantIdentity, idempotencyKey: string, nextAttemptAt: number) {
    const entry = this.bucket(tenant).get(outboxField(idempotencyKey));
    if (entry) {
      entry.status = 3;
      entry.nextAttemptAt = nextAttemptAt;
    }
  }

  async deleteTenant(tenant: TenantIdentity): Promise<DeleteResult> {
    return this.records.delete(outboxKey(validateTenant(tenant))) ? "deleted" : "absent";
  }
}

function environmentValue(env: Environment, key: string) {
  return env[key]?.trim() || undefined;
}

function readCredentialPair(env: Environment, keys: readonly [string, string]) {
  const url = environmentValue(env, keys[0]);
  const token = environmentValue(env, keys[1]);
  if (!url && !token) return undefined;
  if (!url || !token) throw new AlertStoreError("configuration");
  return { url, token };
}

export type AlertStoreFactoryOptions = { env?: Environment; fetchImpl?: typeof fetch };

function resolveCredentials({ env = process.env, fetchImpl = fetch }: AlertStoreFactoryOptions) {
  const environment = environmentValue(env, "NODE_ENV");
  const driver = environmentValue(env, "IKAS_ALERT_STORE_DRIVER");
  if (driver && !["redis", "memory"].includes(driver)) throw new AlertStoreError("configuration");
  if (driver === "memory") {
    if (environment !== "development" && environment !== "test") {
      throw new AlertStoreError("configuration");
    }
    return undefined;
  }
  const credentials =
    readCredentialPair(env, TOKEN_STORE_ENV_KEYS.current) ??
    readCredentialPair(env, TOKEN_STORE_ENV_KEYS.legacyVercelKv);
  if (!credentials) throw new AlertStoreError("configuration");
  return { ...credentials, fetchImpl };
}

export function createLowStockAlertStore(options: AlertStoreFactoryOptions = {}): LowStockAlertStore {
  const credentials = resolveCredentials(options);
  return credentials ? new RedisLowStockAlertStore(credentials) : new MemoryLowStockAlertStore();
}

export function createAlertOutboxStore(options: AlertStoreFactoryOptions = {}): AlertOutboxStore {
  const credentials = resolveCredentials(options);
  return credentials ? new RedisAlertOutboxStore(credentials) : new MemoryAlertOutboxStore();
}

let configuredAlertStore: LowStockAlertStore | undefined;
let configuredOutboxStore: AlertOutboxStore | undefined;

export function lowStockAlertStore() {
  configuredAlertStore ??= createLowStockAlertStore();
  return configuredAlertStore;
}

export function alertOutboxStore() {
  configuredOutboxStore ??= createAlertOutboxStore();
  return configuredOutboxStore;
}

export function resetAlertStoresForTests() {
  configuredAlertStore = undefined;
  configuredOutboxStore = undefined;
}
