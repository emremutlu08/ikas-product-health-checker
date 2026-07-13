import { createHash, randomBytes } from "node:crypto";
import { isValidStoreName } from "./store-name";
import { TOKEN_STORE_ENV_KEYS } from "./token-store";

export const OAUTH_STATE_TTL_MS = 5 * 60_000;
export const OAUTH_STATE_FUTURE_SKEW_MS = 30_000;

const OAUTH_STATE_RANDOM_BYTES = 32;
const REDIS_KEY_PREFIX = "ikas:oauth-state:v1:";
const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const CONSUMED_TOMBSTONE = "__ikas_oauth_state_consumed_v1__";
const OAUTH_STATE_PATTERN = /^v1\.([A-Za-z0-9_-]{43})\.([0-9a-z]{1,11})$/;
const CONSUME_SCRIPT =
  "local value = redis.call('GET', KEYS[1]); if not value then return {0, ''} end; if value == ARGV[1] then return {2, ''} end; redis.call('DEL', KEYS[1]); redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]); return {1, value}";

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

export type OAuthStateRecord = {
  storeName: string;
  createdAt: number;
};

export type OAuthStateConsumeResult =
  | { status: "consumed"; record: OAuthStateRecord }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "replayed" };

export interface OAuthStateStore {
  persist(state: string, record: OAuthStateRecord, ttlMs: number): Promise<void>;
  consume(state: string): Promise<OAuthStateConsumeResult>;
}

export type OAuthStateStoreErrorCode = "configuration" | "backend" | "corrupt_record";
export type OAuthStateStoreOperation = "configure" | "persist" | "consume";

export class OAuthStateStoreError extends Error {
  readonly code: OAuthStateStoreErrorCode;
  readonly operation: OAuthStateStoreOperation;

  constructor(code: OAuthStateStoreErrorCode, operation: OAuthStateStoreOperation) {
    super(`IKAS_OAUTH_STATE_STORE_${code.toUpperCase()}`);
    this.name = "OAuthStateStoreError";
    this.code = code;
    this.operation = operation;
  }
}

export type RedisRestOAuthStateStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  now?: () => number;
};

export type OAuthStateStoreFactoryOptions = {
  env?: Environment;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCreatedAt(createdAt: number) {
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new OAuthStateStoreError("configuration", "persist");
  }
}

function assertState(state: string, operation: "persist" | "consume") {
  if (!isValidOAuthState(state)) {
    throw new OAuthStateStoreError("configuration", operation);
  }
}

function assertTtl(ttlMs: number) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > OAUTH_STATE_TTL_MS) {
    throw new OAuthStateStoreError("configuration", "persist");
  }
}

function stateLookupKey(state: string) {
  const digest = createHash("sha256").update(state, "utf8").digest("base64url");
  return `${REDIS_KEY_PREFIX}${digest}`;
}

function serializeRecord(state: string, record: OAuthStateRecord) {
  assertState(state, "persist");
  assertCreatedAt(record.createdAt);
  if (readOAuthStateCreatedAt(state) !== record.createdAt || !isValidStoreName(record.storeName)) {
    throw new OAuthStateStoreError("configuration", "persist");
  }
  return JSON.stringify({ storeName: record.storeName, createdAt: record.createdAt });
}

function parseStoredRecord(raw: string, state: string): OAuthStateRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OAuthStateStoreError("corrupt_record", "consume");
  }

  if (!isRecord(value)) throw new OAuthStateStoreError("corrupt_record", "consume");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "createdAt" ||
    keys[1] !== "storeName" ||
    typeof value.storeName !== "string" ||
    value.storeName.length === 0 ||
    value.storeName.length > 256 ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) <= 0 ||
    value.createdAt !== readOAuthStateCreatedAt(state)
  ) {
    throw new OAuthStateStoreError("corrupt_record", "consume");
  }

  return { storeName: value.storeName, createdAt: value.createdAt as number };
}

function classifyMissingState(state: string, now: number): OAuthStateConsumeResult {
  const createdAt = readOAuthStateCreatedAt(state);
  return createdAt !== undefined && now - createdAt >= OAUTH_STATE_TTL_MS
    ? { status: "expired" }
    : { status: "missing" };
}

export function generateOAuthState(createdAt = Date.now()) {
  assertCreatedAt(createdAt);
  const entropy = randomBytes(OAUTH_STATE_RANDOM_BYTES).toString("base64url");
  return `v1.${entropy}.${createdAt.toString(36)}`;
}

export function readOAuthStateCreatedAt(state: string) {
  const match = OAUTH_STATE_PATTERN.exec(state);
  if (!match) return undefined;
  const createdAt = Number.parseInt(match[2], 36);
  return Number.isSafeInteger(createdAt) && createdAt > 0 ? createdAt : undefined;
}

export function isValidOAuthState(state: string) {
  return typeof state === "string" && readOAuthStateCreatedAt(state) !== undefined;
}

export class RedisRestOAuthStateStore implements OAuthStateStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;

  constructor({
    url,
    token,
    fetchImpl = fetch,
    requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS,
    now = Date.now,
  }: RedisRestOAuthStateStoreOptions) {
    if (!url.trim() || !token.trim()) throw new OAuthStateStoreError("configuration", "configure");
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 60_000) {
      throw new OAuthStateStoreError("configuration", "configure");
    }

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:") throw new Error("insecure endpoint");
    } catch {
      throw new OAuthStateStoreError("configuration", "configure");
    }

    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.now = now;
  }

  private async command(command: RedisCommand, operation: "persist" | "consume") {
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
      throw new OAuthStateStoreError("backend", operation);
    }

    if (!response.ok) throw new OAuthStateStoreError("backend", operation);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OAuthStateStoreError("backend", operation);
    }

    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new OAuthStateStoreError("backend", operation);
    }
    return payload.result;
  }

  async persist(state: string, record: OAuthStateRecord, ttlMs: number) {
    assertTtl(ttlMs);
    const serialized = serializeRecord(state, record);
    const result = await this.command(
      ["SET", stateLookupKey(state), serialized, "PX", ttlMs, "NX"],
      "persist",
    );
    if (result !== "OK") throw new OAuthStateStoreError("backend", "persist");
  }

  async consume(state: string): Promise<OAuthStateConsumeResult> {
    assertState(state, "consume");
    const result = await this.command(
      ["EVAL", CONSUME_SCRIPT, 1, stateLookupKey(state), CONSUMED_TOMBSTONE, OAUTH_STATE_TTL_MS],
      "consume",
    );
    if (!Array.isArray(result) || result.length !== 2) {
      throw new OAuthStateStoreError("backend", "consume");
    }

    const [status, raw] = result;
    if (status === 0 && raw === "") return classifyMissingState(state, this.now());
    if (status === 2 && raw === "") return { status: "replayed" };
    if (status !== 1 || typeof raw !== "string" || raw === CONSUMED_TOMBSTONE) {
      throw new OAuthStateStoreError("backend", "consume");
    }

    const record = parseStoredRecord(raw, state);
    if (this.now() - record.createdAt >= OAUTH_STATE_TTL_MS) return { status: "expired" };
    return { status: "consumed", record };
  }
}

type MemoryEntry = {
  value: string;
  expiresAt: number;
};

export class MemoryOAuthStateStore implements OAuthStateStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  async persist(state: string, record: OAuthStateRecord, ttlMs: number) {
    assertTtl(ttlMs);
    const serialized = serializeRecord(state, record);
    const key = stateLookupKey(state);
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > this.now()) {
      throw new OAuthStateStoreError("backend", "persist");
    }
    this.entries.set(key, { value: serialized, expiresAt: this.now() + ttlMs });
  }

  async consume(state: string): Promise<OAuthStateConsumeResult> {
    assertState(state, "consume");
    const key = stateLookupKey(state);
    const entry = this.entries.get(key);
    const consumeTime = this.now();
    if (!entry || entry.expiresAt <= consumeTime) {
      this.entries.delete(key);
      return classifyMissingState(state, consumeTime);
    }
    if (entry.value === CONSUMED_TOMBSTONE) return { status: "replayed" };

    const raw = entry.value;
    this.entries.set(key, {
      value: CONSUMED_TOMBSTONE,
      expiresAt: consumeTime + OAUTH_STATE_TTL_MS,
    });
    const record = parseStoredRecord(raw, state);
    if (consumeTime - record.createdAt >= OAUTH_STATE_TTL_MS) return { status: "expired" };
    return { status: "consumed", record };
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
  if (!url || !token) throw new OAuthStateStoreError("configuration", "configure");
  return { url, token };
}

function resolveRedisCredentials(env: Environment) {
  const current = readCredentialPair(env, TOKEN_STORE_ENV_KEYS.current);
  if (current) return current;
  return readCredentialPair(env, TOKEN_STORE_ENV_KEYS.legacyVercelKv);
}

export function createOAuthStateStore({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
}: OAuthStateStoreFactoryOptions = {}): OAuthStateStore {
  const redisCredentials = resolveRedisCredentials(env);
  if (redisCredentials) return new RedisRestOAuthStateStore({ ...redisCredentials, fetchImpl, now });

  const environment = environmentValue(env, "NODE_ENV");
  if (environment === "development" || environment === "test") {
    return new MemoryOAuthStateStore(now);
  }
  throw new OAuthStateStoreError("configuration", "configure");
}

let configuredOAuthStateStore: OAuthStateStore | undefined;

function getConfiguredOAuthStateStore() {
  configuredOAuthStateStore ??= createOAuthStateStore();
  return configuredOAuthStateStore;
}

export async function persistOAuthState(
  state: string,
  record: OAuthStateRecord,
  ttlMs = OAUTH_STATE_TTL_MS,
) {
  await getConfiguredOAuthStateStore().persist(state, record, ttlMs);
}

export async function consumeOAuthState(state: string) {
  return getConfiguredOAuthStateStore().consume(state);
}
