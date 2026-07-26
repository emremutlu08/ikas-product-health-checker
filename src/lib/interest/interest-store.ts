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

/**
 * Paid-feature demand signals. Records are deliberately minimal: they answer "which
 * installation asked for which planned feature", and nothing else. No tokens, no product
 * data, no email address, and no client-supplied tenant identity ever reach this store.
 */
export const INTEREST_INTENTS = ["low_stock_threshold_monitoring"] as const;

export type InterestIntent = (typeof INTEREST_INTENTS)[number];

export type InterestRecord = TenantIdentity & {
  intent: InterestIntent;
  createdAt: number;
};

export type InterestRecordResult = "recorded" | "already_recorded";

export interface InterestStore {
  record(record: InterestRecord): Promise<InterestRecordResult>;
  deleteTenant(tenant: TenantIdentity): Promise<DeleteResult>;
}

export type InterestStoreErrorCode =
  | "configuration"
  | "backend"
  | "corrupt_record"
  | "tenant_mismatch"
  | "tenant_deleted";
export type InterestStoreOperation = "configure" | "record" | "delete_tenant";

export class InterestStoreError extends Error {
  readonly code: InterestStoreErrorCode;
  readonly operation: InterestStoreOperation;

  constructor(code: InterestStoreErrorCode, operation: InterestStoreOperation) {
    super(`IKAS_INTEREST_STORE_${code.toUpperCase()}`);
    this.name = "InterestStoreError";
    this.code = code;
    this.operation = operation;
  }
}

const REDIS_KEY_PREFIX = "ikas:interest:v1:";
const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const RECORD_SCRIPT = [
  `if redis.call('EXISTS', KEYS[2]) == 1 then return '${TENANT_DELETED_REDIS_RESULT}' end`,
  "return redis.call('SET', KEYS[1], ARGV[1], 'NX')",
].join("; ");
const DELETE_TENANT_SCRIPT = [
  "for _, key in ipairs(KEYS) do",
  "local raw = redis.call('GET', key)",
  "if raw then",
  "local ok, record = pcall(cjson.decode, raw)",
  "if not ok or type(record) ~= 'table' or type(record.authorizedAppId) ~= 'string' or type(record.merchantId) ~= 'string' then return -1 end",
  "if record.authorizedAppId ~= ARGV[1] or record.merchantId ~= ARGV[2] then return -2 end",
  "end",
  "end",
  "local deleted = 0",
  "for _, key in ipairs(KEYS) do deleted = deleted + redis.call('DEL', key) end",
  "return deleted",
].join("\n");

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

export type RedisRestInterestStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export type InterestStoreFactoryOptions = {
  env?: Environment;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInterestIntent(value: unknown): value is InterestIntent {
  return typeof value === "string" && (INTEREST_INTENTS as readonly string[]).includes(value);
}

function validateRecord(record: InterestRecord) {
  if (
    !isRecord(record) ||
    !isInterestIntent(record.intent) ||
    typeof record.authorizedAppId !== "string" ||
    !TENANT_ID_PATTERN.test(record.authorizedAppId) ||
    typeof record.merchantId !== "string" ||
    !TENANT_ID_PATTERN.test(record.merchantId) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt <= 0
  ) {
    throw new InterestStoreError("configuration", "record");
  }

  return {
    authorizedAppId: record.authorizedAppId,
    merchantId: record.merchantId,
    intent: record.intent,
    createdAt: record.createdAt,
  } satisfies InterestRecord;
}

/** Idempotency is keyed on authorizedAppId + intent; the tenant id itself is hashed. */
function interestKey(record: Pick<InterestRecord, "authorizedAppId" | "intent">) {
  const digest = createHash("sha256").update(record.authorizedAppId, "utf8").digest("base64url");
  return `${REDIS_KEY_PREFIX}${record.intent}:${digest}`;
}

export class RedisRestInterestStore implements InterestStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor({
    url,
    token,
    fetchImpl = fetch,
    requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS,
  }: RedisRestInterestStoreOptions) {
    if (!url.trim() || !token.trim()) throw new InterestStoreError("configuration", "configure");
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 60_000) {
      throw new InterestStoreError("configuration", "configure");
    }

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:") throw new Error("insecure endpoint");
    } catch {
      throw new InterestStoreError("configuration", "configure");
    }

    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private async command(command: RedisCommand, operation: InterestStoreOperation) {
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
      throw new InterestStoreError("backend", operation);
    }

    if (!response.ok) throw new InterestStoreError("backend", operation);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new InterestStoreError("backend", operation);
    }

    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new InterestStoreError("backend", operation);
    }
    return payload.result;
  }

  async record(record: InterestRecord): Promise<InterestRecordResult> {
    const validated = validateRecord(record);
    const result = await this.command(
      [
        "EVAL",
        RECORD_SCRIPT,
        2,
        interestKey(validated),
        tenantDeletionKey(validated.authorizedAppId),
        JSON.stringify(validated),
      ],
      "record",
    );

    if (result === TENANT_DELETED_REDIS_RESULT) {
      throw new InterestStoreError("tenant_deleted", "record");
    }
    if (result === "OK") return "recorded";
    if (result === null) return "already_recorded";
    throw new InterestStoreError("backend", "record");
  }

  async deleteTenant(tenant: TenantIdentity): Promise<DeleteResult> {
    let validated: TenantIdentity;
    try {
      validated = validateTenantIdentity(tenant);
    } catch (error) {
      if (error instanceof TenantIdentityError) {
        throw new InterestStoreError("configuration", "delete_tenant");
      }
      throw error;
    }
    const keys = INTEREST_INTENTS.map((intent) =>
      interestKey({ authorizedAppId: validated.authorizedAppId, intent }),
    );
    const result = await this.command(
      [
        "EVAL",
        DELETE_TENANT_SCRIPT,
        keys.length,
        ...keys,
        validated.authorizedAppId,
        validated.merchantId,
      ],
      "delete_tenant",
    );
    if (result === -1) throw new InterestStoreError("corrupt_record", "delete_tenant");
    if (result === -2) throw new InterestStoreError("tenant_mismatch", "delete_tenant");
    if (
      typeof result !== "number" ||
      !Number.isSafeInteger(result) ||
      result < 0 ||
      result > keys.length
    ) {
      throw new InterestStoreError("backend", "delete_tenant");
    }
    return result > 0 ? "deleted" : "absent";
  }
}

export class MemoryInterestStore implements InterestStore {
  private readonly entries = new Map<string, string>();

  async record(record: InterestRecord): Promise<InterestRecordResult> {
    const validated = validateRecord(record);
    const key = interestKey(validated);
    if (this.entries.has(key)) return "already_recorded";
    this.entries.set(key, JSON.stringify(validated));
    return "recorded";
  }

  async deleteTenant(tenant: TenantIdentity): Promise<DeleteResult> {
    let validated: TenantIdentity;
    try {
      validated = validateTenantIdentity(tenant);
    } catch (error) {
      if (error instanceof TenantIdentityError) {
        throw new InterestStoreError("configuration", "delete_tenant");
      }
      throw error;
    }
    const keys = INTEREST_INTENTS.map((intent) =>
      interestKey({ authorizedAppId: validated.authorizedAppId, intent }),
    );

    for (const key of keys) {
      const raw = this.entries.get(key);
      if (raw === undefined) continue;
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        throw new InterestStoreError("corrupt_record", "delete_tenant");
      }
      if (
        !isRecord(record) ||
        typeof record.authorizedAppId !== "string" ||
        typeof record.merchantId !== "string"
      ) {
        throw new InterestStoreError("corrupt_record", "delete_tenant");
      }
      if (
        record.authorizedAppId !== validated.authorizedAppId ||
        record.merchantId !== validated.merchantId
      ) {
        throw new InterestStoreError("tenant_mismatch", "delete_tenant");
      }
    }

    let deleted = false;
    for (const key of keys) deleted = this.entries.delete(key) || deleted;
    return deleted ? "deleted" : "absent";
  }
}

function environmentValue(env: Environment, key: string) {
  const value = env[key]?.trim();
  return value || undefined;
}

function readCredentialPair(env: Environment, keys: readonly [string, string]) {
  const url = environmentValue(env, keys[0]);
  const token = environmentValue(env, keys[1]);
  if (!url && !token) return undefined;
  if (!url || !token) throw new InterestStoreError("configuration", "configure");
  return { url, token };
}

function resolveRedisCredentials(env: Environment) {
  const current = readCredentialPair(env, TOKEN_STORE_ENV_KEYS.current);
  if (current) return current;
  return readCredentialPair(env, TOKEN_STORE_ENV_KEYS.legacyVercelKv);
}

/**
 * There is no in-memory fallback here on purpose. A demand signal that silently
 * evaporates is worse than a visible failure, so every environment — including local
 * development — needs real durable credentials before an interest can be recorded.
 */
export function createInterestStore({
  env = process.env,
  fetchImpl = fetch,
}: InterestStoreFactoryOptions = {}): InterestStore {
  const redisCredentials = resolveRedisCredentials(env);
  if (!redisCredentials) throw new InterestStoreError("configuration", "configure");
  return new RedisRestInterestStore({ ...redisCredentials, fetchImpl });
}

let configuredInterestStore: InterestStore | undefined;

export async function recordInterest(record: InterestRecord) {
  configuredInterestStore ??= createInterestStore();
  return configuredInterestStore.record(record);
}

export async function deleteTenantInterestRecords(tenant: TenantIdentity) {
  configuredInterestStore ??= createInterestStore();
  return configuredInterestStore.deleteTenant(tenant);
}
