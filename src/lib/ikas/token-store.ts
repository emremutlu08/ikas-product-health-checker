import { config } from "@/globals/config";
import { OAuthAPI } from "@ikas/admin-api-client";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidStoreName } from "./store-name";

export type StoredIkasToken = {
  authorizedAppId: string;
  merchantId?: string;
  storeName?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
};

export type RefreshLease = {
  authorizedAppId: string;
  ownerId: string;
  fencingToken: number;
};

export interface TokenStore {
  get(authorizedAppId: string): Promise<StoredIkasToken | undefined>;
  set(token: StoredIkasToken): Promise<void>;
  delete(authorizedAppId: string): Promise<void>;
  compareAndSet(expected: StoredIkasToken, replacement: StoredIkasToken): Promise<boolean>;
  deleteIfMatches(expected: StoredIkasToken): Promise<boolean>;
  acquireRefreshLease(authorizedAppId: string, ownerId: string, ttlMs: number): Promise<RefreshLease | undefined>;
  compareAndSetWithRefreshLease(
    lease: RefreshLease,
    expected: StoredIkasToken,
    replacement: StoredIkasToken,
  ): Promise<boolean>;
  deleteIfMatchesWithRefreshLease(lease: RefreshLease, expected: StoredIkasToken): Promise<boolean>;
  releaseRefreshLease(lease: RefreshLease): Promise<boolean>;
}

export type TokenStoreErrorCode = "configuration" | "backend" | "corrupt_record" | "verification_failed";
export type TokenStoreOperation = "configure" | "get" | "set" | "delete" | "lease";

export class TokenStoreError extends Error {
  readonly code: TokenStoreErrorCode;
  readonly operation: TokenStoreOperation;

  constructor(code: TokenStoreErrorCode, operation: TokenStoreOperation) {
    super(`IKAS_TOKEN_STORE_${code.toUpperCase()}`);
    this.name = "TokenStoreError";
    this.code = code;
    this.operation = operation;
  }
}

export type IkasTokenRefreshErrorCode =
  | "configuration"
  | "network"
  | "provider_rejected"
  | "invalid_response"
  | "refresh_busy";

export class IkasTokenRefreshError extends Error {
  readonly code: IkasTokenRefreshErrorCode;

  constructor(code: IkasTokenRefreshErrorCode) {
    super(`IKAS_TOKEN_REFRESH_${code.toUpperCase()}`);
    this.name = "IkasTokenRefreshError";
    this.code = code;
  }
}

export const TOKEN_STORE_ENV_KEYS = {
  current: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const,
  legacyVercelKv: ["KV_REST_API_URL", "KV_REST_API_TOKEN"] as const,
};

const REDIS_KEY_PREFIX = "ikas:token:";
const REDIS_REFRESH_LEASE_KEY_PREFIX = "ikas:token-refresh-lease:";
const REDIS_REFRESH_FENCE_KEY_PREFIX = "ikas:token-refresh-fence:";
const REFRESH_EARLY_MS = 5 * 60_000;
const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const REFRESH_LEASE_TTL_MS = 30_000;
const REFRESH_LEASE_WAIT_MS = 5_000;
const REFRESH_LEASE_POLL_MS = 50;
const CONFIRMED_REFRESH_AUTH_FAILURES = new Set(["invalid_grant", "invalid_refresh_token", "refresh_token_revoked"]);
const COMPARE_AND_SET_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]); return 1 else return 0 end";
const DELETE_IF_MATCHES_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const ACQUIRE_REFRESH_LEASE_SCRIPT =
  "if redis.call('EXISTS', KEYS[1]) == 1 then return {0, ''} end; local fence = redis.call('INCR', KEYS[2]); local value = tostring(fence) .. ':' .. ARGV[1]; redis.call('PSETEX', KEYS[1], ARGV[2], value); return {fence, value}";
const COMPARE_AND_SET_WITH_REFRESH_LEASE_SCRIPT =
  "if redis.call('GET', KEYS[2]) ~= ARGV[1] then return -1 end; if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end; redis.call('SET', KEYS[1], ARGV[3]); return 1";
const DELETE_IF_MATCHES_WITH_REFRESH_LEASE_SCRIPT =
  "if redis.call('GET', KEYS[2]) ~= ARGV[1] then return -1 end; if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end; redis.call('DEL', KEYS[1]); return 1";
const RELEASE_REFRESH_LEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

type RedisRestTokenStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

type FileSystem = Pick<typeof fs, "readFile" | "writeFile">;

type FileTokenStoreOptions = {
  filePath: string;
  fileSystem?: FileSystem;
  now?: () => number;
};

export type TokenStoreFactoryOptions = {
  env?: Environment;
  fetchImpl?: typeof fetch;
  filePath?: string;
  fileSystem?: FileSystem;
};

type OAuthRefreshResponse = {
  ok: boolean;
  status: number;
  data: unknown;
};

export type IkasRefreshClient = (input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  storeName: string;
}) => Promise<OAuthRefreshResponse>;

export type IkasTokenServiceOptions = {
  clientId?: string;
  clientSecret?: string;
  refreshClient?: IkasRefreshClient;
  now?: () => number;
  createLeaseOwnerId?: () => string;
  sleep?: (durationMs: number) => Promise<void>;
  refreshLeaseTtlMs?: number;
  refreshLeaseWaitMs?: number;
  refreshLeasePollMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown) {
  return value === undefined || isNonEmptyString(value);
}

function assertAuthorizedAppId(authorizedAppId: string, operation: TokenStoreOperation) {
  if (!isNonEmptyString(authorizedAppId) || authorizedAppId.length > 256) {
    throw new TokenStoreError("configuration", operation);
  }
}

function assertLeaseOwnerId(ownerId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) {
    throw new TokenStoreError("configuration", "lease");
  }
}

function assertPositiveDuration(durationMs: number) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 5 * 60_000) {
    throw new TokenStoreError("configuration", "lease");
  }
}

function validateRefreshLease(lease: RefreshLease) {
  assertAuthorizedAppId(lease.authorizedAppId, "lease");
  assertLeaseOwnerId(lease.ownerId);
  if (!Number.isSafeInteger(lease.fencingToken) || lease.fencingToken <= 0) {
    throw new TokenStoreError("configuration", "lease");
  }
  return lease;
}

function refreshLeaseValue(lease: RefreshLease) {
  const validated = validateRefreshLease(lease);
  return `${validated.fencingToken}:${validated.ownerId}`;
}

function parseStoredToken(value: unknown, expectedAuthorizedAppId?: string): StoredIkasToken {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.authorizedAppId) ||
    !isNonEmptyString(value.accessToken) ||
    !optionalString(value.merchantId) ||
    !optionalString(value.storeName) ||
    !optionalString(value.refreshToken) ||
    !optionalString(value.tokenType) ||
    (value.expiresAt !== undefined && (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt))) ||
    (expectedAuthorizedAppId !== undefined && value.authorizedAppId !== expectedAuthorizedAppId)
  ) {
    throw new TokenStoreError("corrupt_record", "get");
  }

  return {
    authorizedAppId: value.authorizedAppId,
    accessToken: value.accessToken,
    ...(value.merchantId !== undefined ? { merchantId: value.merchantId as string } : {}),
    ...(value.storeName !== undefined ? { storeName: value.storeName as string } : {}),
    ...(value.refreshToken !== undefined ? { refreshToken: value.refreshToken as string } : {}),
    ...(value.tokenType !== undefined ? { tokenType: value.tokenType as string } : {}),
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
  };
}

function validateTokenForWrite(token: StoredIkasToken) {
  try {
    const parsed = parseStoredToken(token, token.authorizedAppId);
    assertAuthorizedAppId(parsed.authorizedAppId, "set");
    return parsed;
  } catch (error) {
    if (error instanceof TokenStoreError && error.code === "corrupt_record") {
      throw new TokenStoreError("configuration", "set");
    }
    throw error;
  }
}

function sameToken(left: StoredIkasToken, right: StoredIkasToken) {
  return (
    left.authorizedAppId === right.authorizedAppId &&
    left.merchantId === right.merchantId &&
    left.storeName === right.storeName &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.tokenType === right.tokenType &&
    left.expiresAt === right.expiresAt
  );
}

type RefreshableStoredIkasToken = StoredIkasToken & {
  expiresAt: number;
  refreshToken: string;
  storeName: string;
};

function hasUsableRefreshContext(token: StoredIkasToken): token is RefreshableStoredIkasToken {
  return (
    typeof token.expiresAt === "number" &&
    token.expiresAt > 0 &&
    isNonEmptyString(token.refreshToken) &&
    isNonEmptyString(token.storeName) &&
    isValidStoreName(token.storeName)
  );
}

function requiresRefreshMaintenance(token: StoredIkasToken, now: number) {
  return !hasUsableRefreshContext(token) || token.expiresAt <= now + REFRESH_EARLY_MS;
}

function defaultSleep(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

export class RedisRestTokenStore implements TokenStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor({ url, token, fetchImpl = fetch, requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS }: RedisRestTokenStoreOptions) {
    if (!isNonEmptyString(url) || !isNonEmptyString(token)) {
      throw new TokenStoreError("configuration", "configure");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 60_000) {
      throw new TokenStoreError("configuration", "configure");
    }

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:") throw new Error("insecure token store endpoint");
    } catch {
      throw new TokenStoreError("configuration", "configure");
    }

    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private async command(command: RedisCommand, operation: TokenStoreOperation) {
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
      throw new TokenStoreError("backend", operation);
    }

    if (!response.ok) {
      throw new TokenStoreError("backend", operation);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TokenStoreError("backend", operation);
    }

    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new TokenStoreError("backend", operation);
    }

    return payload.result;
  }

  async get(authorizedAppId: string) {
    assertAuthorizedAppId(authorizedAppId, "get");
    const raw = await this.command(["GET", `${REDIS_KEY_PREFIX}${authorizedAppId}`], "get");
    if (raw === null) return undefined;
    if (typeof raw !== "string") throw new TokenStoreError("corrupt_record", "get");

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new TokenStoreError("corrupt_record", "get");
    }
    return parseStoredToken(value, authorizedAppId);
  }

  async set(token: StoredIkasToken) {
    const validated = validateTokenForWrite(token);
    const result = await this.command(
      ["SET", `${REDIS_KEY_PREFIX}${validated.authorizedAppId}`, JSON.stringify(validated)],
      "set",
    );
    if (result !== "OK") throw new TokenStoreError("backend", "set");
  }

  async delete(authorizedAppId: string) {
    assertAuthorizedAppId(authorizedAppId, "delete");
    const result = await this.command(["DEL", `${REDIS_KEY_PREFIX}${authorizedAppId}`], "delete");
    if (typeof result !== "number") throw new TokenStoreError("backend", "delete");
  }

  async compareAndSet(expected: StoredIkasToken, replacement: StoredIkasToken) {
    const validatedExpected = validateTokenForWrite(expected);
    const validatedReplacement = validateTokenForWrite(replacement);
    if (validatedExpected.authorizedAppId !== validatedReplacement.authorizedAppId) {
      throw new TokenStoreError("configuration", "set");
    }
    const result = await this.command(
      [
        "EVAL",
        COMPARE_AND_SET_SCRIPT,
        1,
        `${REDIS_KEY_PREFIX}${validatedExpected.authorizedAppId}`,
        JSON.stringify(validatedExpected),
        JSON.stringify(validatedReplacement),
      ],
      "set",
    );
    if (result !== 0 && result !== 1) throw new TokenStoreError("backend", "set");
    return result === 1;
  }

  async deleteIfMatches(expected: StoredIkasToken) {
    const validated = validateTokenForWrite(expected);
    const result = await this.command(
      [
        "EVAL",
        DELETE_IF_MATCHES_SCRIPT,
        1,
        `${REDIS_KEY_PREFIX}${validated.authorizedAppId}`,
        JSON.stringify(validated),
      ],
      "delete",
    );
    if (result !== 0 && result !== 1) throw new TokenStoreError("backend", "delete");
    return result === 1;
  }

  async acquireRefreshLease(authorizedAppId: string, ownerId: string, ttlMs: number) {
    assertAuthorizedAppId(authorizedAppId, "lease");
    assertLeaseOwnerId(ownerId);
    assertPositiveDuration(ttlMs);
    const result = await this.command(
      [
        "EVAL",
        ACQUIRE_REFRESH_LEASE_SCRIPT,
        2,
        `${REDIS_REFRESH_LEASE_KEY_PREFIX}${authorizedAppId}`,
        `${REDIS_REFRESH_FENCE_KEY_PREFIX}${authorizedAppId}`,
        ownerId,
        ttlMs,
      ],
      "lease",
    );
    if (!Array.isArray(result) || result.length !== 2) throw new TokenStoreError("backend", "lease");
    const [fencingToken, storedValue] = result;
    if (fencingToken === 0 && storedValue === "") return undefined;
    if (
      typeof fencingToken !== "number" ||
      !Number.isSafeInteger(fencingToken) ||
      fencingToken <= 0 ||
      typeof storedValue !== "string"
    ) {
      throw new TokenStoreError("backend", "lease");
    }
    const lease = { authorizedAppId, ownerId, fencingToken };
    if (storedValue !== refreshLeaseValue(lease)) throw new TokenStoreError("backend", "lease");
    return lease;
  }

  async compareAndSetWithRefreshLease(
    lease: RefreshLease,
    expected: StoredIkasToken,
    replacement: StoredIkasToken,
  ) {
    const validatedLease = validateRefreshLease(lease);
    const validatedExpected = validateTokenForWrite(expected);
    const validatedReplacement = validateTokenForWrite(replacement);
    if (
      validatedExpected.authorizedAppId !== validatedLease.authorizedAppId ||
      validatedReplacement.authorizedAppId !== validatedLease.authorizedAppId
    ) {
      throw new TokenStoreError("configuration", "set");
    }
    const result = await this.command(
      [
        "EVAL",
        COMPARE_AND_SET_WITH_REFRESH_LEASE_SCRIPT,
        2,
        `${REDIS_KEY_PREFIX}${validatedLease.authorizedAppId}`,
        `${REDIS_REFRESH_LEASE_KEY_PREFIX}${validatedLease.authorizedAppId}`,
        refreshLeaseValue(validatedLease),
        JSON.stringify(validatedExpected),
        JSON.stringify(validatedReplacement),
      ],
      "set",
    );
    if (result !== -1 && result !== 0 && result !== 1) throw new TokenStoreError("backend", "set");
    return result === 1;
  }

  async deleteIfMatchesWithRefreshLease(lease: RefreshLease, expected: StoredIkasToken) {
    const validatedLease = validateRefreshLease(lease);
    const validatedExpected = validateTokenForWrite(expected);
    if (validatedExpected.authorizedAppId !== validatedLease.authorizedAppId) {
      throw new TokenStoreError("configuration", "delete");
    }
    const result = await this.command(
      [
        "EVAL",
        DELETE_IF_MATCHES_WITH_REFRESH_LEASE_SCRIPT,
        2,
        `${REDIS_KEY_PREFIX}${validatedLease.authorizedAppId}`,
        `${REDIS_REFRESH_LEASE_KEY_PREFIX}${validatedLease.authorizedAppId}`,
        refreshLeaseValue(validatedLease),
        JSON.stringify(validatedExpected),
      ],
      "delete",
    );
    if (result !== -1 && result !== 0 && result !== 1) throw new TokenStoreError("backend", "delete");
    return result === 1;
  }

  async releaseRefreshLease(lease: RefreshLease) {
    const validatedLease = validateRefreshLease(lease);
    const result = await this.command(
      [
        "EVAL",
        RELEASE_REFRESH_LEASE_SCRIPT,
        1,
        `${REDIS_REFRESH_LEASE_KEY_PREFIX}${validatedLease.authorizedAppId}`,
        refreshLeaseValue(validatedLease),
      ],
      "lease",
    );
    if (result !== 0 && result !== 1) throw new TokenStoreError("backend", "lease");
    return result === 1;
  }
}

type LocalRefreshLease = RefreshLease & { expiresAt: number };

export class MemoryTokenStore implements TokenStore {
  private readonly refreshLeases = new Map<string, LocalRefreshLease>();
  private readonly refreshFences = new Map<string, number>();

  constructor(
    private readonly tokens = new Map<string, StoredIkasToken>(),
    private readonly now: () => number = Date.now,
  ) {}

  private activeRefreshLease(authorizedAppId: string) {
    const lease = this.refreshLeases.get(authorizedAppId);
    if (!lease) return undefined;
    if (lease.expiresAt <= this.now()) {
      this.refreshLeases.delete(authorizedAppId);
      return undefined;
    }
    return lease;
  }

  private ownsRefreshLease(lease: RefreshLease) {
    const current = this.activeRefreshLease(lease.authorizedAppId);
    return Boolean(
      current && current.ownerId === lease.ownerId && current.fencingToken === lease.fencingToken,
    );
  }

  async get(authorizedAppId: string) {
    assertAuthorizedAppId(authorizedAppId, "get");
    const token = this.tokens.get(authorizedAppId);
    return token ? parseStoredToken(token, authorizedAppId) : undefined;
  }

  async set(token: StoredIkasToken) {
    const validated = validateTokenForWrite(token);
    this.tokens.set(validated.authorizedAppId, { ...validated });
  }

  async delete(authorizedAppId: string) {
    assertAuthorizedAppId(authorizedAppId, "delete");
    this.tokens.delete(authorizedAppId);
  }

  async compareAndSet(expected: StoredIkasToken, replacement: StoredIkasToken) {
    const validatedExpected = validateTokenForWrite(expected);
    const validatedReplacement = validateTokenForWrite(replacement);
    if (validatedExpected.authorizedAppId !== validatedReplacement.authorizedAppId) {
      throw new TokenStoreError("configuration", "set");
    }
    const current = this.tokens.get(validatedExpected.authorizedAppId);
    if (!current || !sameToken(current, validatedExpected)) return false;
    this.tokens.set(validatedReplacement.authorizedAppId, { ...validatedReplacement });
    return true;
  }

  async deleteIfMatches(expected: StoredIkasToken) {
    const validated = validateTokenForWrite(expected);
    const current = this.tokens.get(validated.authorizedAppId);
    if (!current || !sameToken(current, validated)) return false;
    this.tokens.delete(validated.authorizedAppId);
    return true;
  }

  async acquireRefreshLease(authorizedAppId: string, ownerId: string, ttlMs: number) {
    assertAuthorizedAppId(authorizedAppId, "lease");
    assertLeaseOwnerId(ownerId);
    assertPositiveDuration(ttlMs);
    if (this.activeRefreshLease(authorizedAppId)) return undefined;
    const fencingToken = (this.refreshFences.get(authorizedAppId) ?? 0) + 1;
    this.refreshFences.set(authorizedAppId, fencingToken);
    this.refreshLeases.set(authorizedAppId, {
      authorizedAppId,
      ownerId,
      fencingToken,
      expiresAt: this.now() + ttlMs,
    });
    return { authorizedAppId, ownerId, fencingToken };
  }

  async compareAndSetWithRefreshLease(
    lease: RefreshLease,
    expected: StoredIkasToken,
    replacement: StoredIkasToken,
  ) {
    const validatedLease = validateRefreshLease(lease);
    const validatedExpected = validateTokenForWrite(expected);
    const validatedReplacement = validateTokenForWrite(replacement);
    if (
      validatedExpected.authorizedAppId !== validatedLease.authorizedAppId ||
      validatedReplacement.authorizedAppId !== validatedLease.authorizedAppId
    ) {
      throw new TokenStoreError("configuration", "set");
    }
    if (!this.ownsRefreshLease(validatedLease)) return false;
    const current = this.tokens.get(validatedLease.authorizedAppId);
    if (!current || !sameToken(current, validatedExpected)) return false;
    this.tokens.set(validatedLease.authorizedAppId, { ...validatedReplacement });
    return true;
  }

  async deleteIfMatchesWithRefreshLease(lease: RefreshLease, expected: StoredIkasToken) {
    const validatedLease = validateRefreshLease(lease);
    const validatedExpected = validateTokenForWrite(expected);
    if (validatedExpected.authorizedAppId !== validatedLease.authorizedAppId) {
      throw new TokenStoreError("configuration", "delete");
    }
    if (!this.ownsRefreshLease(validatedLease)) return false;
    const current = this.tokens.get(validatedLease.authorizedAppId);
    if (!current || !sameToken(current, validatedExpected)) return false;
    this.tokens.delete(validatedLease.authorizedAppId);
    return true;
  }

  async releaseRefreshLease(lease: RefreshLease) {
    const validatedLease = validateRefreshLease(lease);
    if (!this.ownsRefreshLease(validatedLease)) return false;
    this.refreshLeases.delete(validatedLease.authorizedAppId);
    return true;
  }
}

export class FileTokenStore implements TokenStore {
  private readonly filePath: string;
  private readonly fileSystem: FileSystem;
  private readonly now: () => number;
  private readonly refreshLeases = new Map<string, LocalRefreshLease>();
  private readonly refreshFences = new Map<string, number>();

  constructor({ filePath, fileSystem = fs, now = Date.now }: FileTokenStoreOptions) {
    if (!isNonEmptyString(filePath)) throw new TokenStoreError("configuration", "configure");
    this.filePath = filePath;
    this.fileSystem = fileSystem;
    this.now = now;
  }

  private activeRefreshLease(authorizedAppId: string) {
    const lease = this.refreshLeases.get(authorizedAppId);
    if (!lease) return undefined;
    if (lease.expiresAt <= this.now()) {
      this.refreshLeases.delete(authorizedAppId);
      return undefined;
    }
    return lease;
  }

  private ownsRefreshLease(lease: RefreshLease) {
    const current = this.activeRefreshLease(lease.authorizedAppId);
    return Boolean(
      current && current.ownerId === lease.ownerId && current.fencingToken === lease.fencingToken,
    );
  }

  private async readAll() {
    let raw: string;
    try {
      raw = await this.fileSystem.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {} as Record<string, StoredIkasToken>;
      throw new TokenStoreError("backend", "get");
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new TokenStoreError("corrupt_record", "get");
    }
    if (!isRecord(value)) throw new TokenStoreError("corrupt_record", "get");

    const tokens: Record<string, StoredIkasToken> = {};
    for (const [authorizedAppId, token] of Object.entries(value)) {
      tokens[authorizedAppId] = parseStoredToken(token, authorizedAppId);
    }
    return tokens;
  }

  private async writeAll(tokens: Record<string, StoredIkasToken>, operation: "set" | "delete") {
    try {
      await this.fileSystem.writeFile(this.filePath, JSON.stringify(tokens, null, 2), "utf8");
    } catch {
      throw new TokenStoreError("backend", operation);
    }
  }

  async get(authorizedAppId: string) {
    assertAuthorizedAppId(authorizedAppId, "get");
    const tokens = await this.readAll();
    return tokens[authorizedAppId] ? { ...tokens[authorizedAppId] } : undefined;
  }

  async set(token: StoredIkasToken) {
    const validated = validateTokenForWrite(token);
    const tokens = await this.readAll();
    tokens[validated.authorizedAppId] = validated;
    await this.writeAll(tokens, "set");
  }

  async delete(authorizedAppId: string) {
    assertAuthorizedAppId(authorizedAppId, "delete");
    const tokens = await this.readAll();
    delete tokens[authorizedAppId];
    await this.writeAll(tokens, "delete");
  }

  async compareAndSet(expected: StoredIkasToken, replacement: StoredIkasToken) {
    const validatedExpected = validateTokenForWrite(expected);
    const validatedReplacement = validateTokenForWrite(replacement);
    if (validatedExpected.authorizedAppId !== validatedReplacement.authorizedAppId) {
      throw new TokenStoreError("configuration", "set");
    }
    const tokens = await this.readAll();
    const current = tokens[validatedExpected.authorizedAppId];
    if (!current || !sameToken(current, validatedExpected)) return false;
    tokens[validatedReplacement.authorizedAppId] = validatedReplacement;
    await this.writeAll(tokens, "set");
    return true;
  }

  async deleteIfMatches(expected: StoredIkasToken) {
    const validated = validateTokenForWrite(expected);
    const tokens = await this.readAll();
    const current = tokens[validated.authorizedAppId];
    if (!current || !sameToken(current, validated)) return false;
    delete tokens[validated.authorizedAppId];
    await this.writeAll(tokens, "delete");
    return true;
  }

  async acquireRefreshLease(authorizedAppId: string, ownerId: string, ttlMs: number) {
    assertAuthorizedAppId(authorizedAppId, "lease");
    assertLeaseOwnerId(ownerId);
    assertPositiveDuration(ttlMs);
    if (this.activeRefreshLease(authorizedAppId)) return undefined;
    const fencingToken = (this.refreshFences.get(authorizedAppId) ?? 0) + 1;
    this.refreshFences.set(authorizedAppId, fencingToken);
    this.refreshLeases.set(authorizedAppId, {
      authorizedAppId,
      ownerId,
      fencingToken,
      expiresAt: this.now() + ttlMs,
    });
    return { authorizedAppId, ownerId, fencingToken };
  }

  async compareAndSetWithRefreshLease(
    lease: RefreshLease,
    expected: StoredIkasToken,
    replacement: StoredIkasToken,
  ) {
    const validatedLease = validateRefreshLease(lease);
    const validatedExpected = validateTokenForWrite(expected);
    const validatedReplacement = validateTokenForWrite(replacement);
    if (
      validatedExpected.authorizedAppId !== validatedLease.authorizedAppId ||
      validatedReplacement.authorizedAppId !== validatedLease.authorizedAppId
    ) {
      throw new TokenStoreError("configuration", "set");
    }
    if (!this.ownsRefreshLease(validatedLease)) return false;
    const tokens = await this.readAll();
    if (!this.ownsRefreshLease(validatedLease)) return false;
    const current = tokens[validatedLease.authorizedAppId];
    if (!current || !sameToken(current, validatedExpected)) return false;
    tokens[validatedLease.authorizedAppId] = validatedReplacement;
    await this.writeAll(tokens, "set");
    return true;
  }

  async deleteIfMatchesWithRefreshLease(lease: RefreshLease, expected: StoredIkasToken) {
    const validatedLease = validateRefreshLease(lease);
    const validatedExpected = validateTokenForWrite(expected);
    if (validatedExpected.authorizedAppId !== validatedLease.authorizedAppId) {
      throw new TokenStoreError("configuration", "delete");
    }
    if (!this.ownsRefreshLease(validatedLease)) return false;
    const tokens = await this.readAll();
    if (!this.ownsRefreshLease(validatedLease)) return false;
    const current = tokens[validatedLease.authorizedAppId];
    if (!current || !sameToken(current, validatedExpected)) return false;
    delete tokens[validatedLease.authorizedAppId];
    await this.writeAll(tokens, "delete");
    return true;
  }

  async releaseRefreshLease(lease: RefreshLease) {
    const validatedLease = validateRefreshLease(lease);
    if (!this.ownsRefreshLease(validatedLease)) return false;
    this.refreshLeases.delete(validatedLease.authorizedAppId);
    return true;
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
  if (!url || !token) throw new TokenStoreError("configuration", "configure");
  return { url, token };
}

function resolveRedisCredentials(env: Environment) {
  const current = readCredentialPair(env, TOKEN_STORE_ENV_KEYS.current);
  if (current) return current;
  return readCredentialPair(env, TOKEN_STORE_ENV_KEYS.legacyVercelKv);
}

export function createTokenStore({
  env = process.env,
  fetchImpl = fetch,
  filePath = path.join(process.cwd(), ".ikas-runtime-tokens.json"),
  fileSystem = fs,
}: TokenStoreFactoryOptions = {}): TokenStore {
  const environment = environmentValue(env, "NODE_ENV");
  const driver = environmentValue(env, "IKAS_TOKEN_STORE_DRIVER");
  if (driver && !["redis", "file", "memory"].includes(driver)) {
    throw new TokenStoreError("configuration", "configure");
  }

  const redisCredentials = resolveRedisCredentials(env);

  if (driver === "file" || driver === "memory") {
    if (environment !== "development" && environment !== "test") {
      throw new TokenStoreError("configuration", "configure");
    }
    return driver === "file" ? new FileTokenStore({ filePath, fileSystem }) : new MemoryTokenStore();
  }

  if (redisCredentials) {
    return new RedisRestTokenStore({ ...redisCredentials, fetchImpl });
  }

  if (environment === "production" || driver === "redis") {
    throw new TokenStoreError("configuration", "configure");
  }

  if (environment === "test") return new MemoryTokenStore();
  if (environment === "development") return new FileTokenStore({ filePath, fileSystem });

  throw new TokenStoreError("configuration", "configure");
}

function oauthErrorCode(data: unknown) {
  if (!isRecord(data)) return undefined;
  const value = typeof data.error === "string" ? data.error : typeof data.code === "string" ? data.code : undefined;
  return value?.trim().toLowerCase();
}

function parseRefreshPayload(data: unknown) {
  if (
    !isRecord(data) ||
    !isNonEmptyString(data.access_token) ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    throw new IkasTokenRefreshError("invalid_response");
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: isNonEmptyString(data.refresh_token) ? data.refresh_token : undefined,
    tokenType: isNonEmptyString(data.token_type) ? data.token_type : undefined,
  };
}

const defaultRefreshClient: IkasRefreshClient = async ({ refreshToken, clientId, clientSecret, storeName }) => {
  if (!isValidStoreName(storeName)) throw new IkasTokenRefreshError("configuration");
  const response = await OAuthAPI.refreshToken(
    {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
    { storeName },
  );
  return { ok: response.ok, status: response.status, data: response.data as unknown };
};

export class IkasTokenService {
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly refreshClient: IkasRefreshClient;
  private readonly now: () => number;
  private readonly createLeaseOwnerId: () => string;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly refreshLeaseTtlMs: number;
  private readonly refreshLeaseWaitMs: number;
  private readonly refreshLeasePollMs: number;

  constructor(
    private readonly store: TokenStore,
    {
      clientId,
      clientSecret,
      refreshClient = defaultRefreshClient,
      now = Date.now,
      createLeaseOwnerId = () => crypto.randomUUID(),
      sleep = defaultSleep,
      refreshLeaseTtlMs = REFRESH_LEASE_TTL_MS,
      refreshLeaseWaitMs = REFRESH_LEASE_WAIT_MS,
      refreshLeasePollMs = REFRESH_LEASE_POLL_MS,
    }: IkasTokenServiceOptions = {},
  ) {
    assertPositiveDuration(refreshLeaseTtlMs);
    assertPositiveDuration(refreshLeasePollMs);
    if (
      !Number.isSafeInteger(refreshLeaseWaitMs) ||
      refreshLeaseWaitMs < 0 ||
      refreshLeaseWaitMs > 5 * 60_000
    ) {
      throw new TokenStoreError("configuration", "lease");
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshClient = refreshClient;
    this.now = now;
    this.createLeaseOwnerId = createLeaseOwnerId;
    this.sleep = sleep;
    this.refreshLeaseTtlMs = refreshLeaseTtlMs;
    this.refreshLeaseWaitMs = refreshLeaseWaitMs;
    this.refreshLeasePollMs = refreshLeasePollMs;
  }

  async persistAndVerify(token: StoredIkasToken) {
    const validated = validateTokenForWrite(token);
    await this.store.set(validated);
    const stored = await this.store.get(validated.authorizedAppId);
    if (!stored || !sameToken(validated, stored)) {
      throw new TokenStoreError("verification_failed", "set");
    }
    return stored;
  }

  async invalidate(authorizedAppId: string) {
    await this.store.delete(authorizedAppId);
  }

  async invalidateIfCurrent(token: StoredIkasToken) {
    return this.store.deleteIfMatches(token);
  }

  private async maintainTokenWithLease(authorizedAppId: string, lease: RefreshLease) {
    try {
      const token = await this.store.get(authorizedAppId);
      if (!token || !requiresRefreshMaintenance(token, this.now())) return token;

      if (!hasUsableRefreshContext(token)) {
        const deleted = await this.store.deleteIfMatchesWithRefreshLease(lease, token);
        const current = await this.store.get(authorizedAppId);
        if (deleted || !current || !sameToken(current, token)) return current;
        throw new IkasTokenRefreshError("refresh_busy");
      }

      if (!this.clientId || !this.clientSecret) {
        throw new IkasTokenRefreshError("configuration");
      }

      let response: OAuthRefreshResponse;
      try {
        response = await this.refreshClient({
          refreshToken: token.refreshToken,
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          storeName: token.storeName,
        });
      } catch {
        throw new IkasTokenRefreshError("network");
      }

      if (!response.ok) {
        const errorCode = oauthErrorCode(response.data);
        if (
          (response.status === 400 || response.status === 401) &&
          errorCode &&
          CONFIRMED_REFRESH_AUTH_FAILURES.has(errorCode)
        ) {
          const deleted = await this.store.deleteIfMatchesWithRefreshLease(lease, token);
          const current = await this.store.get(authorizedAppId);
          if (deleted || !current || !sameToken(current, token)) return current;
          throw new IkasTokenRefreshError("refresh_busy");
        }
        throw new IkasTokenRefreshError("provider_rejected");
      }

      const refreshedPayload = parseRefreshPayload(response.data);
      const refreshedToken = validateTokenForWrite({
        ...token,
        accessToken: refreshedPayload.accessToken,
        refreshToken: refreshedPayload.refreshToken ?? token.refreshToken,
        tokenType: refreshedPayload.tokenType ?? token.tokenType,
        expiresAt: this.now() + refreshedPayload.expiresIn * 1000,
      });
      const replaced = await this.store.compareAndSetWithRefreshLease(lease, token, refreshedToken);
      const current = await this.store.get(authorizedAppId);
      if (replaced && current && sameToken(current, refreshedToken)) return current;
      if (!current || sameToken(current, token)) {
        throw new TokenStoreError("verification_failed", "set");
      }
      return current;
    } finally {
      await this.store.releaseRefreshLease(lease);
    }
  }

  async get(authorizedAppId: string): Promise<StoredIkasToken | undefined> {
    let token = await this.store.get(authorizedAppId);
    if (!token || !requiresRefreshMaintenance(token, this.now())) return token;

    const ownerId = this.createLeaseOwnerId();
    assertLeaseOwnerId(ownerId);
    const acquisitionAttempts = Math.floor(this.refreshLeaseWaitMs / this.refreshLeasePollMs) + 1;

    for (let attempt = 0; attempt < acquisitionAttempts; attempt += 1) {
      const lease = await this.store.acquireRefreshLease(authorizedAppId, ownerId, this.refreshLeaseTtlMs);
      if (lease) return this.maintainTokenWithLease(authorizedAppId, lease);
      if (attempt + 1 >= acquisitionAttempts) break;

      await this.sleep(this.refreshLeasePollMs);
      token = await this.store.get(authorizedAppId);
      if (!token || !requiresRefreshMaintenance(token, this.now())) return token;
    }

    token = await this.store.get(authorizedAppId);
    if (!token || !requiresRefreshMaintenance(token, this.now())) return token;
    throw new IkasTokenRefreshError("refresh_busy");
  }
}

let configuredTokenService: IkasTokenService | undefined;

function createConfiguredTokenService() {
  configuredTokenService ??= new IkasTokenService(createTokenStore(), {
    clientId: config.oauth.clientId,
    clientSecret: config.oauth.clientSecret,
  });
  return configuredTokenService;
}

export async function saveIkasToken(token: StoredIkasToken) {
  return createConfiguredTokenService().persistAndVerify(token);
}

export async function invalidateIkasToken(
  authorizedAppId?: string | null,
  expectedToken?: StoredIkasToken,
) {
  if (!authorizedAppId) return;
  const service = createConfiguredTokenService();
  if (expectedToken) return service.invalidateIfCurrent(expectedToken);
  await service.invalidate(authorizedAppId);
}

export async function getIkasToken(authorizedAppId?: string | null) {
  if (!authorizedAppId) return undefined;
  return createConfiguredTokenService().get(authorizedAppId);
}
