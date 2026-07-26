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

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const REDIS_KEY_PREFIX = "ikas:monitoring-schedule:v2:";
const CLAIM_SCRIPT = [
  `if redis.call('EXISTS', KEYS[4]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "local previous = redis.call('GET', KEYS[1])",
  "if previous and tonumber(ARGV[2]) - tonumber(previous) < tonumber(ARGV[3]) then return false end",
  "local acquired = redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[4])",
  "if not acquired then return false end",
  "local delivery = redis.call('GET', KEYS[3])",
  "if not delivery then redis.call('SET', KEYS[3], ARGV[1], 'NX'); delivery = redis.call('GET', KEYS[3]) end",
  "return delivery",
].join("; ");
const COMPLETE_SCRIPT = [
  `if redis.call('EXISTS', KEYS[4]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "redis.call('DEL', KEYS[2])",
  "redis.call('DEL', KEYS[3])",
  "return 1",
].join("; ");
const RELEASE_SCRIPT = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "redis.call('DEL', KEYS[1])",
  "return 1",
].join("; ");
const DELETE_TENANT_SCRIPT =
  "return redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])";

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

export type MonitoringScheduleTenant = TenantIdentity;

export type MonitoringRunClaim = {
  tenant: MonitoringScheduleTenant;
  ownerId: string;
  deliveryId: string;
};

export interface MonitoringScheduleStore {
  claimIfDue(
    tenant: MonitoringScheduleTenant,
    ownerId: string,
    attemptedAtMs: number,
    minimumIntervalMs: number,
    leaseTtlMs: number,
  ): Promise<MonitoringRunClaim | undefined>;
  complete(claim: MonitoringRunClaim, completedAtMs: number): Promise<boolean>;
  release(claim: MonitoringRunClaim): Promise<boolean>;
  deleteTenant(tenant: MonitoringScheduleTenant): Promise<DeleteResult>;
}

export class MonitoringScheduleStoreError extends Error {
  readonly code: "configuration" | "backend" | "tenant_deleted";

  constructor(code: MonitoringScheduleStoreError["code"]) {
    super(`IKAS_MONITORING_SCHEDULE_${code.toUpperCase()}`);
    this.name = "MonitoringScheduleStoreError";
    this.code = code;
  }
}

function validateTenant(tenant: MonitoringScheduleTenant) {
  try {
    return validateTenantIdentity(tenant);
  } catch (error) {
    if (error instanceof TenantIdentityError) {
      throw new MonitoringScheduleStoreError("configuration");
    }
    throw error;
  }
}

function validateOwner(ownerId: string) {
  if (!SAFE_ID_PATTERN.test(ownerId)) throw new MonitoringScheduleStoreError("configuration");
  return ownerId;
}

function validateTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new MonitoringScheduleStoreError("configuration");
}

function validateDuration(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 7 * 24 * 60 * 60 * 1000) {
    throw new MonitoringScheduleStoreError("configuration");
  }
}

function scheduleBaseKey(tenant: MonitoringScheduleTenant) {
  const validated = validateTenant(tenant);
  const digest = createHash("sha256")
    .update([validated.authorizedAppId, validated.merchantId].join("\u0000"), "utf8")
    .digest("base64url");
  return `${REDIS_KEY_PREFIX}${digest}`;
}

function keysFor(tenant: MonitoringScheduleTenant) {
  const base = scheduleBaseKey(tenant);
  return { success: `${base}:success`, lease: `${base}:lease`, delivery: `${base}:delivery` };
}

export class MemoryMonitoringScheduleStore implements MonitoringScheduleStore {
  private readonly successes = new Map<string, number>();
  private readonly leases = new Map<string, { ownerId: string; expiresAt: number }>();
  private readonly deliveries = new Map<string, string>();

  async claimIfDue(
    tenant: MonitoringScheduleTenant,
    ownerId: string,
    attemptedAtMs: number,
    minimumIntervalMs: number,
    leaseTtlMs: number,
  ) {
    validateOwner(ownerId);
    validateTimestamp(attemptedAtMs);
    validateDuration(minimumIntervalMs);
    validateDuration(leaseTtlMs);
    const key = scheduleBaseKey(tenant);
    const previous = this.successes.get(key);
    if (previous !== undefined && attemptedAtMs - previous < minimumIntervalMs) return undefined;
    const lease = this.leases.get(key);
    if (lease && lease.expiresAt > attemptedAtMs) return undefined;
    this.leases.set(key, { ownerId, expiresAt: attemptedAtMs + leaseTtlMs });
    const deliveryId = this.deliveries.get(key) ?? ownerId;
    this.deliveries.set(key, deliveryId);
    return { tenant: { ...tenant }, ownerId, deliveryId };
  }

  async complete(claim: MonitoringRunClaim, completedAtMs: number) {
    validateOwner(claim.ownerId);
    validateTimestamp(completedAtMs);
    const key = scheduleBaseKey(claim.tenant);
    if (this.leases.get(key)?.ownerId !== claim.ownerId) return false;
    this.successes.set(key, completedAtMs);
    this.leases.delete(key);
    this.deliveries.delete(key);
    return true;
  }

  async release(claim: MonitoringRunClaim) {
    validateOwner(claim.ownerId);
    const key = scheduleBaseKey(claim.tenant);
    if (this.leases.get(key)?.ownerId !== claim.ownerId) return false;
    this.leases.delete(key);
    return true;
  }

  async deleteTenant(tenant: MonitoringScheduleTenant): Promise<DeleteResult> {
    const key = scheduleBaseKey(tenant);
    const deleted =
      Number(this.successes.delete(key)) +
      Number(this.leases.delete(key)) +
      Number(this.deliveries.delete(key));
    return deleted > 0 ? "deleted" : "absent";
  }
}

export class RedisRestMonitoringScheduleStore implements MonitoringScheduleStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor({
    url,
    token,
    fetchImpl = fetch,
    requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS,
  }: {
    url: string;
    token: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  }) {
    if (!url?.trim() || !token?.trim() || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new MonitoringScheduleStoreError("configuration");
    }
    try {
      if (new URL(url).protocol !== "https:") throw new Error("insecure");
    } catch {
      throw new MonitoringScheduleStoreError("configuration");
    }
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private async command(command: RedisCommand) {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(command),
        cache: "no-store",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new MonitoringScheduleStoreError("backend");
    }
    if (!response.ok) throw new MonitoringScheduleStoreError("backend");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MonitoringScheduleStoreError("backend");
    }
    if (typeof payload !== "object" || payload === null || !("result" in payload)) {
      throw new MonitoringScheduleStoreError("backend");
    }
    return (payload as { result: unknown }).result;
  }

  async claimIfDue(
    tenant: MonitoringScheduleTenant,
    ownerId: string,
    attemptedAtMs: number,
    minimumIntervalMs: number,
    leaseTtlMs: number,
  ) {
    validateOwner(ownerId);
    validateTimestamp(attemptedAtMs);
    validateDuration(minimumIntervalMs);
    validateDuration(leaseTtlMs);
    const keys = keysFor(tenant);
    const result = await this.command([
      "EVAL",
      CLAIM_SCRIPT,
      4,
      keys.success,
      keys.lease,
      keys.delivery,
      tenantDeletionKey(tenant.authorizedAppId),
      ownerId,
      String(attemptedAtMs),
      String(minimumIntervalMs),
      String(leaseTtlMs),
    ]);
    if (result === TENANT_DELETED_REDIS_RESULT) {
      throw new MonitoringScheduleStoreError("tenant_deleted");
    }
    if (result === null || result === false || result === 0) return undefined;
    if (typeof result !== "string" || !SAFE_ID_PATTERN.test(result)) {
      throw new MonitoringScheduleStoreError("backend");
    }
    return { tenant: { ...tenant }, ownerId, deliveryId: result };
  }

  async complete(claim: MonitoringRunClaim, completedAtMs: number) {
    validateOwner(claim.ownerId);
    validateTimestamp(completedAtMs);
    const keys = keysFor(claim.tenant);
    const result = await this.command([
      "EVAL",
      COMPLETE_SCRIPT,
      4,
      keys.success,
      keys.lease,
      keys.delivery,
      tenantDeletionKey(claim.tenant.authorizedAppId),
      claim.ownerId,
      String(completedAtMs),
    ]);
    if (result === TENANT_DELETED_REDIS_RESULT) {
      throw new MonitoringScheduleStoreError("tenant_deleted");
    }
    return result === 1;
  }

  async release(claim: MonitoringRunClaim) {
    validateOwner(claim.ownerId);
    const { lease } = keysFor(claim.tenant);
    return (await this.command(["EVAL", RELEASE_SCRIPT, 1, lease, claim.ownerId])) === 1;
  }

  async deleteTenant(tenant: MonitoringScheduleTenant): Promise<DeleteResult> {
    const keys = keysFor(tenant);
    const result = await this.command([
      "EVAL",
      DELETE_TENANT_SCRIPT,
      3,
      keys.success,
      keys.lease,
      keys.delivery,
    ]);
    if (
      typeof result !== "number" ||
      !Number.isSafeInteger(result) ||
      result < 0 ||
      result > 3
    ) {
      throw new MonitoringScheduleStoreError("backend");
    }
    return result > 0 ? "deleted" : "absent";
  }
}

function value(env: Environment, key: string) {
  return env[key]?.trim() || undefined;
}

function credentials(env: Environment) {
  for (const [urlKey, tokenKey] of [TOKEN_STORE_ENV_KEYS.current, TOKEN_STORE_ENV_KEYS.legacyVercelKv]) {
    const url = value(env, urlKey);
    const token = value(env, tokenKey);
    if (!url && !token) continue;
    if (!url || !token) throw new MonitoringScheduleStoreError("configuration");
    return { url, token };
  }
  return undefined;
}

export function createMonitoringScheduleStore({
  env = process.env,
  fetchImpl = fetch,
}: {
  env?: Environment;
  fetchImpl?: typeof fetch;
} = {}): MonitoringScheduleStore {
  const driver = value(env, "IKAS_SCHEDULE_STORE_DRIVER");
  if (driver && driver !== "redis" && driver !== "memory") {
    throw new MonitoringScheduleStoreError("configuration");
  }
  if (driver === "memory") {
    const environment = value(env, "NODE_ENV");
    if (environment !== "development" && environment !== "test") {
      throw new MonitoringScheduleStoreError("configuration");
    }
    return new MemoryMonitoringScheduleStore();
  }
  const pair = credentials(env);
  if (!pair) throw new MonitoringScheduleStoreError("configuration");
  return new RedisRestMonitoringScheduleStore({ ...pair, fetchImpl });
}

let configuredStore: MonitoringScheduleStore | undefined;

function scheduleStore() {
  configuredStore ??= createMonitoringScheduleStore();
  return configuredStore;
}

export function claimMonitoringRunIfDue(
  tenant: MonitoringScheduleTenant,
  ownerId: string,
  attemptedAtMs: number,
  minimumIntervalMs: number,
  leaseTtlMs: number,
) {
  return scheduleStore().claimIfDue(tenant, ownerId, attemptedAtMs, minimumIntervalMs, leaseTtlMs);
}

export function completeMonitoringRun(claim: MonitoringRunClaim, completedAtMs: number) {
  return scheduleStore().complete(claim, completedAtMs);
}

export function releaseMonitoringRun(claim: MonitoringRunClaim) {
  return scheduleStore().release(claim);
}

export function deleteTenantMonitoringSchedule(tenant: MonitoringScheduleTenant) {
  return scheduleStore().deleteTenant(tenant);
}
