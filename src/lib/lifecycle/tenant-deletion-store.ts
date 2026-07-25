import { TOKEN_STORE_ENV_KEYS } from "@/lib/ikas/token-store";
import {
  TenantIdentityError,
  tenantDeletionKey,
  tenantDeletionMarker,
  validateTenantIdentity,
  type TenantIdentity,
} from "./tenant-identity";

export type MarkTenantDeletedResult = "marked" | "already_marked";

export interface TenantDeletionStore {
  markDeleted(tenant: TenantIdentity): Promise<MarkTenantDeletedResult>;
}

export type TenantDeletionStoreErrorCode = "configuration" | "backend" | "identity_mismatch";
export type TenantDeletionStoreOperation = "configure" | "mark_deleted";

export class TenantDeletionStoreError extends Error {
  readonly code: TenantDeletionStoreErrorCode;
  readonly operation: TenantDeletionStoreOperation;

  constructor(code: TenantDeletionStoreErrorCode, operation: TenantDeletionStoreOperation) {
    super(`IKAS_TENANT_DELETION_STORE_${code.toUpperCase()}`);
    this.name = "TenantDeletionStoreError";
    this.code = code;
    this.operation = operation;
  }
}

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

export type RedisRestTenantDeletionStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const MARK_DELETED_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  "if not current then redis.call('SET', KEYS[1], ARGV[1]); return 1 end",
  "if current == ARGV[1] then return 0 end",
  "return -1",
].join("; ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTenant(tenant: TenantIdentity): TenantIdentity {
  try {
    return validateTenantIdentity(tenant);
  } catch (error) {
    if (error instanceof TenantIdentityError) {
      throw new TenantDeletionStoreError("configuration", "mark_deleted");
    }
    throw error;
  }
}

export class RedisRestTenantDeletionStore implements TenantDeletionStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor({
    url,
    token,
    fetchImpl = fetch,
    requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS,
  }: RedisRestTenantDeletionStoreOptions) {
    if (!url?.trim() || !token?.trim()) {
      throw new TenantDeletionStoreError("configuration", "configure");
    }
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > 60_000
    ) {
      throw new TenantDeletionStoreError("configuration", "configure");
    }
    try {
      if (new URL(url).protocol !== "https:") throw new Error("insecure");
    } catch {
      throw new TenantDeletionStoreError("configuration", "configure");
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
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
        cache: "no-store",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new TenantDeletionStoreError("backend", "mark_deleted");
    }
    if (!response.ok) throw new TenantDeletionStoreError("backend", "mark_deleted");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TenantDeletionStoreError("backend", "mark_deleted");
    }
    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new TenantDeletionStoreError("backend", "mark_deleted");
    }
    return payload.result;
  }

  async markDeleted(tenant: TenantIdentity): Promise<MarkTenantDeletedResult> {
    const validated = validateTenant(tenant);
    const result = await this.command([
      "EVAL",
      MARK_DELETED_SCRIPT,
      1,
      tenantDeletionKey(validated.authorizedAppId),
      tenantDeletionMarker(validated),
    ]);
    if (result === 1) return "marked";
    if (result === 0) return "already_marked";
    if (result === -1) {
      throw new TenantDeletionStoreError("identity_mismatch", "mark_deleted");
    }
    throw new TenantDeletionStoreError("backend", "mark_deleted");
  }
}

export class MemoryTenantDeletionStore implements TenantDeletionStore {
  private readonly markers = new Map<string, string>();

  async markDeleted(tenant: TenantIdentity): Promise<MarkTenantDeletedResult> {
    const validated = validateTenant(tenant);
    const key = tenantDeletionKey(validated.authorizedAppId);
    const marker = tenantDeletionMarker(validated);
    const current = this.markers.get(key);
    if (current === marker) return "already_marked";
    if (current !== undefined) {
      throw new TenantDeletionStoreError("identity_mismatch", "mark_deleted");
    }
    this.markers.set(key, marker);
    return "marked";
  }
}

function environmentValue(env: Environment, key: string) {
  return env[key]?.trim() || undefined;
}

function redisCredentials(env: Environment) {
  for (const [urlKey, tokenKey] of [
    TOKEN_STORE_ENV_KEYS.current,
    TOKEN_STORE_ENV_KEYS.legacyVercelKv,
  ]) {
    const url = environmentValue(env, urlKey);
    const token = environmentValue(env, tokenKey);
    if (!url && !token) continue;
    if (!url || !token) {
      throw new TenantDeletionStoreError("configuration", "configure");
    }
    return { url, token };
  }
  return undefined;
}

export function createTenantDeletionStore({
  env = process.env,
  fetchImpl = fetch,
}: {
  env?: Environment;
  fetchImpl?: typeof fetch;
} = {}): TenantDeletionStore {
  const credentials = redisCredentials(env);
  if (!credentials) throw new TenantDeletionStoreError("configuration", "configure");
  return new RedisRestTenantDeletionStore({ ...credentials, fetchImpl });
}
