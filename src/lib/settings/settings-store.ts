import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TOKEN_STORE_ENV_KEYS } from "@/lib/ikas/token-store";

/**
 * Tenant-bound monitoring settings.
 *
 * A record holds only the knobs a merchant can turn: the low-stock threshold and whether the
 * daily email summary is on. It carries no token, no email address, no product data, and no
 * raw tenant identifier — the tenant is expressed only as a hash in the Redis key. Reads fail
 * closed: anything outside the contract is refused rather than coerced into a value a scan
 * could act on.
 */
export type MonitoringSettings = {
  /** Integer 0..1000. 0 disables low-stock warnings. */
  lowStockThreshold: number;
  dailyEmailEnabled: boolean;
};

export const MIN_LOW_STOCK_THRESHOLD = 0;
export const MAX_LOW_STOCK_THRESHOLD = 1_000;

/** The only value served when nothing durable exists, and the fail-closed value on any doubt. */
export const DEFAULT_MONITORING_SETTINGS: MonitoringSettings = {
  lowStockThreshold: 0,
  dailyEmailEnabled: false,
};

export type SettingsTenant = {
  authorizedAppId: string;
  merchantId: string;
};

export interface MonitoringSettingsStore {
  get(tenant: SettingsTenant): Promise<MonitoringSettings | undefined>;
  put(tenant: SettingsTenant, settings: MonitoringSettings): Promise<void>;
}

export type MonitoringSettingsStoreErrorCode =
  | "configuration"
  | "backend"
  | "corrupt_record"
  | "payload_too_large";
export type MonitoringSettingsStoreOperation = "configure" | "get" | "put";

export class MonitoringSettingsStoreError extends Error {
  readonly code: MonitoringSettingsStoreErrorCode;
  readonly operation: MonitoringSettingsStoreOperation;

  constructor(code: MonitoringSettingsStoreErrorCode, operation: MonitoringSettingsStoreOperation) {
    super(`IKAS_SETTINGS_STORE_${code.toUpperCase()}`);
    this.name = "MonitoringSettingsStoreError";
    this.code = code;
    this.operation = operation;
  }
}

/**
 * A settings record is a handful of bytes. The ceiling only exists so a corrupted or hostile
 * value is refused before it is expanded into memory, never as a real capacity target.
 */
export const MAX_SETTINGS_BYTES = 512;
const REDIS_KEY_PREFIX = "ikas:monitoring-settings:v1:";
const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

export type RedisRestMonitoringSettingsStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export type MonitoringSettingsStoreFactoryOptions = {
  env?: Environment;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidLowStockThreshold(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_LOW_STOCK_THRESHOLD &&
    value <= MAX_LOW_STOCK_THRESHOLD
  );
}

/** Parses an arbitrary value into settings, or returns undefined so callers fail closed. */
export function parseMonitoringSettings(value: unknown): MonitoringSettings | undefined {
  if (
    !isRecord(value) ||
    !isValidLowStockThreshold(value.lowStockThreshold) ||
    typeof value.dailyEmailEnabled !== "boolean"
  ) {
    return undefined;
  }
  return {
    lowStockThreshold: value.lowStockThreshold,
    dailyEmailEnabled: value.dailyEmailEnabled,
  };
}

function validateSettingsForWrite(settings: MonitoringSettings): MonitoringSettings {
  const parsed = parseMonitoringSettings(settings);
  if (!parsed) throw new MonitoringSettingsStoreError("configuration", "put");
  return parsed;
}

function validateTenant(
  tenant: SettingsTenant,
  operation: MonitoringSettingsStoreOperation,
): SettingsTenant {
  if (
    !isRecord(tenant) ||
    typeof tenant.authorizedAppId !== "string" ||
    !TENANT_ID_PATTERN.test(tenant.authorizedAppId) ||
    typeof tenant.merchantId !== "string" ||
    !TENANT_ID_PATTERN.test(tenant.merchantId)
  ) {
    throw new MonitoringSettingsStoreError("configuration", operation);
  }
  return { authorizedAppId: tenant.authorizedAppId, merchantId: tenant.merchantId };
}

/** Both identifiers participate, so one tenant's key can never address another's record. */
function settingsKey(tenant: SettingsTenant) {
  const digest = createHash("sha256")
    .update(`${tenant.authorizedAppId} ${tenant.merchantId}`, "utf8")
    .digest("base64url");
  return `${REDIS_KEY_PREFIX}${digest}`;
}

function parseStoredSettings(raw: unknown): MonitoringSettings {
  if (typeof raw !== "string") throw new MonitoringSettingsStoreError("corrupt_record", "get");
  if (Buffer.byteLength(raw, "utf8") > MAX_SETTINGS_BYTES) {
    throw new MonitoringSettingsStoreError("payload_too_large", "get");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MonitoringSettingsStoreError("corrupt_record", "get");
  }

  const parsed = parseMonitoringSettings(value);
  if (!parsed) throw new MonitoringSettingsStoreError("corrupt_record", "get");
  return parsed;
}

function serializeSettings(settings: MonitoringSettings): string {
  const serialized = JSON.stringify(settings);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_BYTES) {
    throw new MonitoringSettingsStoreError("configuration", "put");
  }
  return serialized;
}

export class RedisRestMonitoringSettingsStore implements MonitoringSettingsStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor({
    url,
    token,
    fetchImpl = fetch,
    requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS,
  }: RedisRestMonitoringSettingsStoreOptions) {
    if (!url?.trim() || !token?.trim()) {
      throw new MonitoringSettingsStoreError("configuration", "configure");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 60_000) {
      throw new MonitoringSettingsStoreError("configuration", "configure");
    }
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:") throw new Error("insecure endpoint");
    } catch {
      throw new MonitoringSettingsStoreError("configuration", "configure");
    }

    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private async command(command: RedisCommand, operation: MonitoringSettingsStoreOperation) {
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
      throw new MonitoringSettingsStoreError("backend", operation);
    }

    if (!response.ok) throw new MonitoringSettingsStoreError("backend", operation);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MonitoringSettingsStoreError("backend", operation);
    }

    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new MonitoringSettingsStoreError("backend", operation);
    }
    return payload.result;
  }

  async get(tenant: SettingsTenant) {
    const validated = validateTenant(tenant, "get");
    const raw = await this.command(["GET", settingsKey(validated)], "get");
    if (raw === null) return undefined;
    return parseStoredSettings(raw);
  }

  async put(tenant: SettingsTenant, settings: MonitoringSettings) {
    const validated = validateTenant(tenant, "put");
    const serialized = serializeSettings(validateSettingsForWrite(settings));
    const result = await this.command(["SET", settingsKey(validated), serialized], "put");
    if (result !== "OK") throw new MonitoringSettingsStoreError("backend", "put");
  }
}

export class MemoryMonitoringSettingsStore implements MonitoringSettingsStore {
  private readonly records = new Map<string, string>();

  async get(tenant: SettingsTenant) {
    const validated = validateTenant(tenant, "get");
    const raw = this.records.get(settingsKey(validated));
    if (raw === undefined) return undefined;
    return parseStoredSettings(raw);
  }

  async put(tenant: SettingsTenant, settings: MonitoringSettings) {
    const validated = validateTenant(tenant, "put");
    this.records.set(settingsKey(validated), serializeSettings(validateSettingsForWrite(settings)));
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
  if (!url || !token) throw new MonitoringSettingsStoreError("configuration", "configure");
  return { url, token };
}

function resolveRedisCredentials(env: Environment) {
  const current = readCredentialPair(env, TOKEN_STORE_ENV_KEYS.current);
  if (current) return current;
  return readCredentialPair(env, TOKEN_STORE_ENV_KEYS.legacyVercelKv);
}

export function createMonitoringSettingsStore({
  env = process.env,
  fetchImpl = fetch,
}: MonitoringSettingsStoreFactoryOptions = {}): MonitoringSettingsStore {
  const environment = environmentValue(env, "NODE_ENV");
  const driver = environmentValue(env, "IKAS_SETTINGS_STORE_DRIVER");
  if (driver && !["redis", "memory"].includes(driver)) {
    throw new MonitoringSettingsStoreError("configuration", "configure");
  }

  if (driver === "memory") {
    if (environment !== "development" && environment !== "test") {
      throw new MonitoringSettingsStoreError("configuration", "configure");
    }
    return new MemoryMonitoringSettingsStore();
  }

  const redisCredentials = resolveRedisCredentials(env);
  if (!redisCredentials) throw new MonitoringSettingsStoreError("configuration", "configure");
  return new RedisRestMonitoringSettingsStore({ ...redisCredentials, fetchImpl });
}

let configuredSettingsStore: MonitoringSettingsStore | undefined;

function settingsStore() {
  configuredSettingsStore ??= createMonitoringSettingsStore();
  return configuredSettingsStore;
}

export async function getTenantMonitoringSettings(tenant: SettingsTenant) {
  return settingsStore().get(tenant);
}

export async function putTenantMonitoringSettings(tenant: SettingsTenant, settings: MonitoringSettings) {
  return settingsStore().put(tenant, settings);
}
