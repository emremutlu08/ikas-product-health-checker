import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isValidStoreName } from "@/lib/ikas/store-name";
import { TOKEN_STORE_ENV_KEYS } from "@/lib/ikas/token-store";

/**
 * Durable index of installed tenants, used only by the server-side daily scheduler to know
 * which installations exist.
 *
 * A record is exactly one validated {@link InstallationRegistryRecord}: the authorized app id,
 * the merchant id, and the store name. It deliberately holds no access token, no refresh token,
 * no email address, and no product data — none of which the scheduler needs and all of which
 * would turn this index into a second copy of the token store.
 *
 * Raw tenant identifiers never appear in the Redis key space. Every installation lives as one
 * field of a single bounded hash, and the field name is a SHA-256 digest of
 * `authorizedAppId + NUL + merchantId`, so the key set leaks neither which apps nor which
 * merchants are installed. The record value carries the plain identifiers because the scheduler
 * must reconstruct them to read snapshots and run scans; that value is server-only and never
 * served to a client.
 */
export type InstallationRegistryRecord = {
  authorizedAppId: string;
  merchantId: string;
  storeName: string;
};

/**
 * Hard ceiling on the number of distinct installations the registry will hold. The registry is
 * a single Redis hash, and this bound caps its field count so a runaway or hostile install loop
 * cannot grow it without limit. A new tenant past the ceiling is refused; an existing tenant is
 * always still updatable, so a full registry never locks out a re-install.
 */
export const MAX_REGISTRY_ENTRIES = 100;

/** Fixed, tenant-free key for the one bounded hash that holds every installation record. */
export const REGISTRY_REDIS_KEY = "ikas:installation-registry:v1";

/**
 * A record is three short identifiers. The ceiling only exists so a corrupted or hostile value
 * is refused before it is expanded into memory, never as a real capacity target.
 */
const MAX_REGISTRY_RECORD_BYTES = 512;

const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const REDIS_REQUEST_TIMEOUT_MS = 5_000;

/**
 * One atomic upsert. A field that already exists is overwritten idempotently, so re-installing a
 * tenant only refreshes its store name. A field that does not exist is refused once the hash has
 * reached its ceiling, so the bound is enforced inside Redis rather than in a read-modify-write
 * that could race two concurrent installs.
 */
const UPSERT_SCRIPT = [
  "if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end",
  "redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])",
  "return 1",
].join("; ");

export type InstallationRegistryStoreErrorCode =
  | "configuration"
  | "backend"
  | "corrupt_record"
  | "payload_too_large"
  | "capacity";
export type InstallationRegistryStoreOperation = "configure" | "register" | "list" | "reconcile";

export class InstallationRegistryStoreError extends Error {
  readonly code: InstallationRegistryStoreErrorCode;
  readonly operation: InstallationRegistryStoreOperation;

  constructor(
    code: InstallationRegistryStoreErrorCode,
    operation: InstallationRegistryStoreOperation,
  ) {
    super(`IKAS_REGISTRY_STORE_${code.toUpperCase()}`);
    this.name = "InstallationRegistryStoreError";
    this.code = code;
    this.operation = operation;
  }
}

export interface InstallationRegistryStore {
  register(record: InstallationRegistryRecord): Promise<void>;
  list(): Promise<InstallationRegistryRecord[]>;
  has(record: InstallationRegistryRecord): Promise<boolean>;
}

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

export type RedisRestInstallationRegistryStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export type InstallationRegistryStoreFactoryOptions = {
  env?: Environment;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses an arbitrary value into a registry record, or returns undefined so callers fail closed. */
export function parseInstallationRegistryRecord(
  value: unknown,
): InstallationRegistryRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.authorizedAppId !== "string" ||
    !TENANT_ID_PATTERN.test(value.authorizedAppId) ||
    typeof value.merchantId !== "string" ||
    !TENANT_ID_PATTERN.test(value.merchantId) ||
    typeof value.storeName !== "string" ||
    !isValidStoreName(value.storeName)
  ) {
    return undefined;
  }
  // Only the three identity fields survive, so an extra token/email key in the same object is
  // structurally dropped rather than persisted.
  return {
    authorizedAppId: value.authorizedAppId,
    merchantId: value.merchantId,
    storeName: value.storeName,
  };
}

function validateRecordForWrite(record: InstallationRegistryRecord): InstallationRegistryRecord {
  const parsed = parseInstallationRegistryRecord(record);
  if (!parsed) throw new InstallationRegistryStoreError("configuration", "register");
  return parsed;
}

/** Both identifiers participate, NUL-separated, so one tenant's field can never address another's. */
function recordDigest(record: InstallationRegistryRecord) {
  return createHash("sha256")
    .update([record.authorizedAppId, record.merchantId].join("\u0000"), "utf8")
    .digest("base64url");
}

function serializeRecord(record: InstallationRegistryRecord): string {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REGISTRY_RECORD_BYTES) {
    throw new InstallationRegistryStoreError("configuration", "register");
  }
  return serialized;
}

/**
 * Turns one stored hash field into a record, or undefined if it is unusable. A value that is too
 * large, unparseable, outside the contract, or whose own identity disagrees with the digest it
 * was filed under is discarded rather than trusted: the scheduler simply will not scan a tenant
 * it cannot read cleanly.
 */
function parseListedRecord(field: string, raw: string): InstallationRegistryRecord | undefined {
  if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_RECORD_BYTES) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const record = parseInstallationRegistryRecord(value);
  if (!record) return undefined;
  // Defence in depth: the field is derived from the ids, so a record whose recomputed digest does
  // not match the field it lives under is a planted or corrupted entry and is dropped.
  if (recordDigest(record) !== field) return undefined;
  return record;
}

export class RedisRestInstallationRegistryStore implements InstallationRegistryStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor({
    url,
    token,
    fetchImpl = fetch,
    requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS,
  }: RedisRestInstallationRegistryStoreOptions) {
    if (!url?.trim() || !token?.trim()) {
      throw new InstallationRegistryStoreError("configuration", "configure");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 60_000) {
      throw new InstallationRegistryStoreError("configuration", "configure");
    }
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:") throw new Error("insecure endpoint");
    } catch {
      throw new InstallationRegistryStoreError("configuration", "configure");
    }

    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private async command(command: RedisCommand, operation: InstallationRegistryStoreOperation) {
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
      throw new InstallationRegistryStoreError("backend", operation);
    }

    if (!response.ok) throw new InstallationRegistryStoreError("backend", operation);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new InstallationRegistryStoreError("backend", operation);
    }

    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new InstallationRegistryStoreError("backend", operation);
    }
    return payload.result;
  }

  async register(record: InstallationRegistryRecord) {
    const validated = validateRecordForWrite(record);
    const result = await this.command(
      [
        "EVAL",
        UPSERT_SCRIPT,
        1,
        REGISTRY_REDIS_KEY,
        recordDigest(validated),
        serializeRecord(validated),
        String(MAX_REGISTRY_ENTRIES),
      ],
      "register",
    );
    if (result === 0) throw new InstallationRegistryStoreError("capacity", "register");
    if (result !== 1) throw new InstallationRegistryStoreError("backend", "register");
  }

  async list() {
    const raw = await this.command(["HGETALL", REGISTRY_REDIS_KEY], "list");
    if (!Array.isArray(raw)) throw new InstallationRegistryStoreError("backend", "list");
    // A hash bounded to MAX_REGISTRY_ENTRIES fields returns at most twice that many array
    // elements. Anything larger is a corrupted or overgrown structure and is refused whole
    // rather than parsed.
    if (raw.length > MAX_REGISTRY_ENTRIES * 2) {
      throw new InstallationRegistryStoreError("payload_too_large", "list");
    }

    const records: InstallationRegistryRecord[] = [];
    for (let index = 0; index + 1 < raw.length && records.length < MAX_REGISTRY_ENTRIES; index += 2) {
      const field = raw[index];
      const value = raw[index + 1];
      if (typeof field !== "string" || typeof value !== "string") continue;
      const record = parseListedRecord(field, value);
      if (record) records.push(record);
    }
    return records;
  }

  async has(record: InstallationRegistryRecord) {
    const validated = validateRecordForWrite(record);
    const field = recordDigest(validated);
    const raw = await this.command(["HGET", REGISTRY_REDIS_KEY, field], "reconcile");
    if (raw === null) return false;
    if (typeof raw !== "string") throw new InstallationRegistryStoreError("backend", "reconcile");
    return parseListedRecord(field, raw)?.storeName === validated.storeName;
  }
}

export class MemoryInstallationRegistryStore implements InstallationRegistryStore {
  private readonly fields = new Map<string, string>();

  async register(record: InstallationRegistryRecord) {
    const validated = validateRecordForWrite(record);
    const serialized = serializeRecord(validated);
    const field = recordDigest(validated);
    if (!this.fields.has(field) && this.fields.size >= MAX_REGISTRY_ENTRIES) {
      throw new InstallationRegistryStoreError("capacity", "register");
    }
    this.fields.set(field, serialized);
  }

  async list() {
    const records: InstallationRegistryRecord[] = [];
    for (const [field, value] of this.fields) {
      if (records.length >= MAX_REGISTRY_ENTRIES) break;
      const record = parseListedRecord(field, value);
      if (record) records.push(record);
    }
    return records;
  }

  async has(record: InstallationRegistryRecord) {
    const validated = validateRecordForWrite(record);
    const field = recordDigest(validated);
    const raw = this.fields.get(field);
    if (!raw) return false;
    return parseListedRecord(field, raw)?.storeName === validated.storeName;
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
  if (!url || !token) throw new InstallationRegistryStoreError("configuration", "configure");
  return { url, token };
}

function resolveRedisCredentials(env: Environment) {
  const current = readCredentialPair(env, TOKEN_STORE_ENV_KEYS.current);
  if (current) return current;
  return readCredentialPair(env, TOKEN_STORE_ENV_KEYS.legacyVercelKv);
}

export function createInstallationRegistryStore({
  env = process.env,
  fetchImpl = fetch,
}: InstallationRegistryStoreFactoryOptions = {}): InstallationRegistryStore {
  const environment = environmentValue(env, "NODE_ENV");
  const driver = environmentValue(env, "IKAS_REGISTRY_STORE_DRIVER");
  if (driver && !["redis", "memory"].includes(driver)) {
    throw new InstallationRegistryStoreError("configuration", "configure");
  }

  if (driver === "memory") {
    if (environment !== "development" && environment !== "test") {
      throw new InstallationRegistryStoreError("configuration", "configure");
    }
    return new MemoryInstallationRegistryStore();
  }

  const redisCredentials = resolveRedisCredentials(env);
  if (!redisCredentials) throw new InstallationRegistryStoreError("configuration", "configure");
  return new RedisRestInstallationRegistryStore({ ...redisCredentials, fetchImpl });
}

let configuredRegistryStore: InstallationRegistryStore | undefined;

function registryStore() {
  configuredRegistryStore ??= createInstallationRegistryStore();
  return configuredRegistryStore;
}

export async function registerInstallation(record: InstallationRegistryRecord) {
  return registryStore().register(record);
}

export async function isInstallationRegistered(record: InstallationRegistryRecord) {
  return registryStore().has(record);
}

export async function listRegisteredInstallations() {
  return registryStore().list();
}
