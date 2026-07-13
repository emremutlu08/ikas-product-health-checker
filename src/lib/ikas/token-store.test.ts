import { describe, expect, it, vi } from "vitest";
import {
  createTokenStore,
  FileTokenStore,
  getIkasToken,
  IkasTokenRefreshError,
  IkasTokenService,
  MemoryTokenStore,
  RedisRestTokenStore,
  saveIkasToken,
  TokenStoreError,
  type StoredIkasToken,
  type TokenStore,
} from "./token-store";

const REDIS_URL = "https://fake-upstash.example.com";
const REDIS_TOKEN = "fake-redis-token";
const NOW = Date.parse("2026-07-13T10:00:00.000Z");

const baseToken: StoredIkasToken = {
  authorizedAppId: "authorized-app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  tokenType: "Bearer",
  expiresAt: NOW + 60 * 60_000,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createFakeRedisRest() {
  const records = new Map<string, string>();
  const expirations = new Map<string, number>();
  const counters = new Map<string, number>();
  let forcedStatus: number | undefined;
  let now = NOW;

  function getRecord(key: string) {
    const expiresAt = expirations.get(key);
    if (expiresAt !== undefined && expiresAt <= now) {
      expirations.delete(key);
      records.delete(key);
    }
    return records.get(key);
  }

  function deleteRecord(key: string) {
    expirations.delete(key);
    return records.delete(key);
  }

  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (forcedStatus) return new Response(null, { status: forcedStatus });
    const command = JSON.parse(String(init?.body)) as Array<string | number>;
    const [name, key, value] = command;
    if (name === "SET" && typeof key === "string" && typeof value === "string") {
      records.set(key, value);
      expirations.delete(key);
      return jsonResponse({ result: "OK" });
    }
    if (name === "GET" && typeof key === "string") {
      return jsonResponse({ result: getRecord(key) ?? null });
    }
    if (name === "DEL" && typeof key === "string") {
      const deleted = deleteRecord(key);
      return jsonResponse({ result: deleted ? 1 : 0 });
    }
    if (name === "EVAL") {
      const script = command[1];
      if (typeof script !== "string") return jsonResponse({ error: "unsupported" });

      if (script.includes("PSETEX") && script.includes("INCR")) {
        const leaseKey = command[3];
        const fenceKey = command[4];
        const ownerId = command[5];
        const ttlMs = command[6];
        if (
          typeof leaseKey !== "string" ||
          typeof fenceKey !== "string" ||
          typeof ownerId !== "string" ||
          typeof ttlMs !== "number"
        ) {
          return jsonResponse({ error: "unsupported" });
        }
        if (getRecord(leaseKey) !== undefined) return jsonResponse({ result: [0, ""] });
        const fencingToken = (counters.get(fenceKey) ?? 0) + 1;
        counters.set(fenceKey, fencingToken);
        const leaseValue = `${fencingToken}:${ownerId}`;
        records.set(leaseKey, leaseValue);
        expirations.set(leaseKey, now + ttlMs);
        return jsonResponse({ result: [fencingToken, leaseValue] });
      }

      const keyCount = command[2];
      if (keyCount === 2) {
        const tokenKey = command[3];
        const leaseKey = command[4];
        const leaseValue = command[5];
        const expected = command[6];
        const replacement = command[7];
        if (
          typeof tokenKey !== "string" ||
          typeof leaseKey !== "string" ||
          typeof leaseValue !== "string" ||
          typeof expected !== "string"
        ) {
          return jsonResponse({ error: "unsupported" });
        }
        if (getRecord(leaseKey) !== leaseValue) return jsonResponse({ result: -1 });
        if (getRecord(tokenKey) !== expected) return jsonResponse({ result: 0 });
        if (script.includes("ARGV[3]") && typeof replacement === "string") {
          records.set(tokenKey, replacement);
          return jsonResponse({ result: 1 });
        }
        if (script.includes("redis.call('DEL', KEYS[1])")) {
          deleteRecord(tokenKey);
          return jsonResponse({ result: 1 });
        }
      }

      const evalKey = command[3];
      const expected = command[4];
      const replacement = command[5];
      if (typeof evalKey !== "string" || typeof expected !== "string" || getRecord(evalKey) !== expected) {
        return jsonResponse({ result: 0 });
      }
      if (script.includes("redis.call('SET'") && typeof replacement === "string") {
        records.set(evalKey, replacement);
        return jsonResponse({ result: 1 });
      }
      if (script.includes("redis.call('DEL'")) {
        deleteRecord(evalKey);
        return jsonResponse({ result: 1 });
      }
    }
    return jsonResponse({ error: "unsupported" });
  });

  return {
    records,
    fetchMock,
    failWithStatus(status: number) {
      forcedStatus = status;
    },
    advanceTime(durationMs: number) {
      now += durationMs;
    },
  };
}

async function expectTokenStoreContract(store: TokenStore) {
  expect(await store.get("missing-app")).toBeUndefined();
  await store.set(baseToken);
  expect(await store.get(baseToken.authorizedAppId)).toEqual(baseToken);
  const replacement = { ...baseToken, accessToken: "access-token-replacement" };
  expect(await store.compareAndSet(baseToken, replacement)).toBe(true);
  expect(await store.deleteIfMatches(baseToken)).toBe(false);
  expect(await store.get(baseToken.authorizedAppId)).toEqual(replacement);
  await store.delete(baseToken.authorizedAppId);
  expect(await store.get(baseToken.authorizedAppId)).toBeUndefined();
  await store.set(replacement);
  expect(await store.deleteIfMatches(replacement)).toBe(true);
  expect(await store.get(baseToken.authorizedAppId)).toBeUndefined();

  await store.set(baseToken);
  const firstLease = await store.acquireRefreshLease(baseToken.authorizedAppId, "contract-owner-1", 30_000);
  expect(firstLease).toMatchObject({ fencingToken: 1 });
  if (!firstLease) throw new Error("expected first refresh lease");
  expect(
    await store.acquireRefreshLease(baseToken.authorizedAppId, "contract-owner-2", 30_000),
  ).toBeUndefined();
  const leasedReplacement = { ...baseToken, accessToken: "access-token-leased" };
  expect(await store.compareAndSetWithRefreshLease(firstLease, baseToken, leasedReplacement)).toBe(true);
  expect(await store.releaseRefreshLease(firstLease)).toBe(true);
  expect(await store.compareAndSetWithRefreshLease(firstLease, leasedReplacement, baseToken)).toBe(false);

  const secondLease = await store.acquireRefreshLease(baseToken.authorizedAppId, "contract-owner-2", 30_000);
  expect(secondLease?.fencingToken).toBe(2);
  if (!secondLease) throw new Error("expected second refresh lease");
  expect(await store.deleteIfMatchesWithRefreshLease(secondLease, leasedReplacement)).toBe(true);
  expect(await store.releaseRefreshLease(secondLease)).toBe(true);
  expect(await store.get(baseToken.authorizedAppId)).toBeUndefined();
}

describe("TokenStore contract", () => {
  it("is implemented by the in-memory non-production store", async () => {
    await expectTokenStoreContract(new MemoryTokenStore());
  });

  it("is implemented by the file-backed local-development store", async () => {
    let contents: string | undefined;
    const readFile = vi.fn(async () => {
      if (contents === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return contents;
    });
    const writeFile = vi.fn(async (_filePath: string, value: string) => {
      contents = value;
    });
    const store = new FileTokenStore({
      filePath: "/tmp/fake-token-store.json",
      fileSystem: { readFile, writeFile } as never,
    });

    await expectTokenStoreContract(store);
  });

  it("is implemented by the Redis-compatible REST store", async () => {
    const fakeRedis = createFakeRedisRest();
    const store = new RedisRestTokenStore({
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fakeRedis.fetchMock as typeof fetch,
    });

    await expectTokenStoreContract(store);

    expect(fakeRedis.fetchMock).toHaveBeenCalled();
    expect(JSON.parse(String(fakeRedis.fetchMock.mock.calls[1]?.[1]?.body)).slice(0, 2)).toEqual([
      "SET",
      "ikas:token:authorized-app-1",
    ]);
  });

  it("reads a token from a separate Redis store instance", async () => {
    const fakeRedis = createFakeRedisRest();
    const options = {
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fakeRedis.fetchMock as typeof fetch,
    };
    const writer = new RedisRestTokenStore(options);
    const reader = new RedisRestTokenStore(options);

    await writer.set(baseToken);

    expect(await reader.get(baseToken.authorizedAppId)).toEqual(baseToken);
  });

  it("distinguishes a missing token from a Redis backend failure", async () => {
    const fakeRedis = createFakeRedisRest();
    const store = new RedisRestTokenStore({
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fakeRedis.fetchMock as typeof fetch,
    });

    expect(await store.get("missing-app")).toBeUndefined();
    fakeRedis.failWithStatus(503);

    await expect(store.get("missing-app")).rejects.toMatchObject({ code: "backend", operation: "get" });
  });

  it("bounds Redis REST requests with an AbortSignal timeout", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const store = new RedisRestTokenStore({
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fetchMock as typeof fetch,
      requestTimeoutMs: 5,
    });

    await expect(store.get("missing-app")).rejects.toMatchObject({ code: "backend", operation: "get" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects malformed durable records instead of treating them as missing", async () => {
    const fakeRedis = createFakeRedisRest();
    fakeRedis.records.set("ikas:token:authorized-app-1", "{not-json");
    const store = new RedisRestTokenStore({
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fakeRedis.fetchMock as typeof fetch,
    });

    await expect(store.get("authorized-app-1")).rejects.toMatchObject({ code: "corrupt_record" });
  });
});

describe("Redis refresh lease fencing", () => {
  it("uses monotonic fences and an exact-value release that cannot delete a successor lease", async () => {
    const fakeRedis = createFakeRedisRest();
    const options = {
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fakeRedis.fetchMock as typeof fetch,
    };
    const firstStore = new RedisRestTokenStore(options);
    const secondStore = new RedisRestTokenStore(options);
    await firstStore.set(baseToken);

    const firstLease = await firstStore.acquireRefreshLease(baseToken.authorizedAppId, "owner-first", 100);
    expect(firstLease?.fencingToken).toBe(1);
    if (!firstLease) throw new Error("expected first lease");

    fakeRedis.advanceTime(101);
    const secondLease = await secondStore.acquireRefreshLease(baseToken.authorizedAppId, "owner-second", 100);
    expect(secondLease?.fencingToken).toBe(2);
    if (!secondLease) throw new Error("expected second lease");

    expect(await firstStore.releaseRefreshLease(firstLease)).toBe(false);
    expect(
      await firstStore.acquireRefreshLease(baseToken.authorizedAppId, "owner-third", 100),
    ).toBeUndefined();

    const replacement = { ...baseToken, accessToken: "access-token-fence-2" };
    expect(await secondStore.compareAndSetWithRefreshLease(secondLease, baseToken, replacement)).toBe(true);
    expect(await firstStore.compareAndSetWithRefreshLease(firstLease, replacement, baseToken)).toBe(false);
    expect(await firstStore.deleteIfMatchesWithRefreshLease(firstLease, replacement)).toBe(false);
    expect(await secondStore.releaseRefreshLease(secondLease)).toBe(true);
    expect(await firstStore.get(baseToken.authorizedAppId)).toEqual(replacement);
  });
});

describe("token store selection", () => {
  it("forbids production filesystem fallback before any filesystem call", () => {
    const readFile = vi.fn();
    const writeFile = vi.fn();

    expect(() =>
      createTokenStore({
        env: { NODE_ENV: "production", IKAS_TOKEN_STORE_DRIVER: "file" },
        fileSystem: { readFile, writeFile } as never,
      }),
    ).toThrow(TokenStoreError);
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("forbids production memory storage", () => {
    expect(() =>
      createTokenStore({ env: { NODE_ENV: "production", IKAS_TOKEN_STORE_DRIVER: "memory" } }),
    ).toThrow("IKAS_TOKEN_STORE_CONFIGURATION");
  });

  it("requires an explicit development or test environment for local drivers", () => {
    expect(() => createTokenStore({ env: { IKAS_TOKEN_STORE_DRIVER: "file" } })).toThrow(
      "IKAS_TOKEN_STORE_CONFIGURATION",
    );
    expect(() =>
      createTokenStore({ env: { NODE_ENV: "staging", IKAS_TOKEN_STORE_DRIVER: "memory" } }),
    ).toThrow("IKAS_TOKEN_STORE_CONFIGURATION");
  });

  it("fails closed in production when persistent credentials are missing", () => {
    expect(() => createTokenStore({ env: { NODE_ENV: "production" } })).toThrow(
      "IKAS_TOKEN_STORE_CONFIGURATION",
    );
  });

  it("rejects a partial current Upstash credential pair", () => {
    expect(() =>
      createTokenStore({
        env: { NODE_ENV: "production", UPSTASH_REDIS_REST_URL: REDIS_URL },
      }),
    ).toThrow("IKAS_TOKEN_STORE_CONFIGURATION");
  });

  it("rejects partial legacy and mixed credential families", () => {
    expect(() =>
      createTokenStore({ env: { NODE_ENV: "production", KV_REST_API_TOKEN: REDIS_TOKEN } }),
    ).toThrow("IKAS_TOKEN_STORE_CONFIGURATION");
    expect(() =>
      createTokenStore({
        env: {
          NODE_ENV: "production",
          UPSTASH_REDIS_REST_URL: REDIS_URL,
          KV_REST_API_TOKEN: REDIS_TOKEN,
        },
      }),
    ).toThrow("IKAS_TOKEN_STORE_CONFIGURATION");
  });

  it("prefers the current Upstash pair and accepts the legacy Vercel KV pair atomically", () => {
    const current = createTokenStore({
      env: {
        NODE_ENV: "production",
        UPSTASH_REDIS_REST_URL: REDIS_URL,
        UPSTASH_REDIS_REST_TOKEN: REDIS_TOKEN,
      },
    });
    const legacy = createTokenStore({
      env: {
        NODE_ENV: "production",
        KV_REST_API_URL: REDIS_URL,
        KV_REST_API_TOKEN: REDIS_TOKEN,
      },
    });

    expect(current).toBeInstanceOf(RedisRestTokenStore);
    expect(legacy).toBeInstanceOf(RedisRestTokenStore);
  });

  it("allows file or memory stores only in explicit non-production environments", () => {
    expect(
      createTokenStore({
        env: { NODE_ENV: "development", IKAS_TOKEN_STORE_DRIVER: "file" },
        filePath: "/tmp/explicit-local-token-store.json",
      }),
    ).toBeInstanceOf(FileTokenStore);
    expect(
      createTokenStore({ env: { NODE_ENV: "test", IKAS_TOKEN_STORE_DRIVER: "memory" } }),
    ).toBeInstanceOf(MemoryTokenStore);
  });
});

describe("IkasTokenService refresh lifecycle", () => {
  it("serializes concurrent rotating refreshes across separate Redis store instances", async () => {
    const fakeRedis = createFakeRedisRest();
    const options = {
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fakeRedis.fetchMock as typeof fetch,
    };
    const firstStore = new RedisRestTokenStore(options);
    const secondStore = new RedisRestTokenStore(options);
    await firstStore.set({ ...baseToken, expiresAt: NOW });

    const providerStarted = deferred();
    const releaseProvider = deferred();
    const waiterSleeping = deferred();
    const releaseWaiter = deferred();
    const refreshClient = vi.fn(async ({ refreshToken }: { refreshToken: string }) => {
      expect(refreshToken).toBe("refresh-token-1");
      providerStarted.resolve();
      await releaseProvider.promise;
      return {
        ok: true,
        status: 200,
        data: {
          access_token: "access-token-2",
          refresh_token: "refresh-token-2",
          expires_in: 3600,
        },
      };
    });
    const commonOptions = {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient,
      now: () => NOW,
      refreshLeaseTtlMs: 1_000,
      refreshLeaseWaitMs: 100,
      refreshLeasePollMs: 10,
    };
    const firstService = new IkasTokenService(firstStore, {
      ...commonOptions,
      createLeaseOwnerId: () => "concurrent-owner-1",
    });
    const secondService = new IkasTokenService(secondStore, {
      ...commonOptions,
      createLeaseOwnerId: () => "concurrent-owner-2",
      sleep: async () => {
        waiterSleeping.resolve();
        await releaseWaiter.promise;
      },
    });

    const firstResultPromise = firstService.get(baseToken.authorizedAppId);
    await providerStarted.promise;
    const secondResultPromise = secondService.get(baseToken.authorizedAppId);
    await waiterSleeping.promise;
    expect(refreshClient).toHaveBeenCalledOnce();

    releaseProvider.resolve();
    const firstResult = await firstResultPromise;
    releaseWaiter.resolve();
    const secondResult = await secondResultPromise;

    expect(firstResult).toMatchObject({ accessToken: "access-token-2", refreshToken: "refresh-token-2" });
    expect(secondResult).toEqual(firstResult);
    expect(refreshClient).toHaveBeenCalledOnce();
    expect(await secondStore.get(baseToken.authorizedAppId)).toEqual(firstResult);
  });

  it("does not let a stale invalid_grant loser delete the fenced winner token", async () => {
    const fakeRedis = createFakeRedisRest();
    const options = {
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fakeRedis.fetchMock as typeof fetch,
    };
    const firstStore = new RedisRestTokenStore(options);
    const secondStore = new RedisRestTokenStore(options);
    await firstStore.set({ ...baseToken, expiresAt: NOW });

    const staleRequestStarted = deferred();
    const releaseStaleRequest = deferred();
    let call = 0;
    const refreshClient = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        staleRequestStarted.resolve();
        await releaseStaleRequest.promise;
        return { ok: false, status: 400, data: { error: "invalid_grant" } };
      }
      return {
        ok: true,
        status: 200,
        data: { access_token: "winner-access-token", refresh_token: "winner-refresh-token", expires_in: 3600 },
      };
    });
    const firstService = new IkasTokenService(firstStore, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient,
      now: () => NOW,
      createLeaseOwnerId: () => "stale-owner",
      refreshLeaseTtlMs: 100,
      refreshLeaseWaitMs: 0,
      refreshLeasePollMs: 10,
    });
    const secondService = new IkasTokenService(secondStore, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient,
      now: () => NOW,
      createLeaseOwnerId: () => "winner-owner",
      refreshLeaseTtlMs: 100,
      refreshLeaseWaitMs: 0,
      refreshLeasePollMs: 10,
    });

    const staleResultPromise = firstService.get(baseToken.authorizedAppId);
    await staleRequestStarted.promise;
    fakeRedis.advanceTime(101);
    const winnerResult = await secondService.get(baseToken.authorizedAppId);
    releaseStaleRequest.resolve();
    const staleResult = await staleResultPromise;

    expect(winnerResult).toMatchObject({
      accessToken: "winner-access-token",
      refreshToken: "winner-refresh-token",
    });
    expect(staleResult).toEqual(winnerResult);
    expect(await firstStore.get(baseToken.authorizedAppId)).toEqual(winnerResult);
  });

  it("does not let a stale successful refresh overwrite a higher-fenced winner", async () => {
    const fakeRedis = createFakeRedisRest();
    const options = {
      url: REDIS_URL,
      token: REDIS_TOKEN,
      fetchImpl: fakeRedis.fetchMock as typeof fetch,
    };
    const firstStore = new RedisRestTokenStore(options);
    const secondStore = new RedisRestTokenStore(options);
    await firstStore.set({ ...baseToken, expiresAt: NOW });

    const staleRequestStarted = deferred();
    const releaseStaleRequest = deferred();
    let call = 0;
    const refreshClient = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        staleRequestStarted.resolve();
        await releaseStaleRequest.promise;
        return {
          ok: true,
          status: 200,
          data: { access_token: "stale-access-token", refresh_token: "stale-refresh-token", expires_in: 3600 },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { access_token: "winner-access-token", refresh_token: "winner-refresh-token", expires_in: 3600 },
      };
    });
    const serviceOptions = {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient,
      now: () => NOW,
      refreshLeaseTtlMs: 100,
      refreshLeaseWaitMs: 0,
      refreshLeasePollMs: 10,
    };
    const firstService = new IkasTokenService(firstStore, {
      ...serviceOptions,
      createLeaseOwnerId: () => "stale-success-owner",
    });
    const secondService = new IkasTokenService(secondStore, {
      ...serviceOptions,
      createLeaseOwnerId: () => "winner-success-owner",
    });

    const staleResultPromise = firstService.get(baseToken.authorizedAppId);
    await staleRequestStarted.promise;
    fakeRedis.advanceTime(101);
    const winnerResult = await secondService.get(baseToken.authorizedAppId);
    releaseStaleRequest.resolve();
    const staleResult = await staleResultPromise;

    expect(winnerResult).toMatchObject({
      accessToken: "winner-access-token",
      refreshToken: "winner-refresh-token",
    });
    expect(staleResult).toEqual(winnerResult);
    expect(await firstStore.get(baseToken.authorizedAppId)).toEqual(winnerResult);
  });

  it("re-reads the durable token immediately after acquiring the lease", async () => {
    const store = new MemoryTokenStore();
    const expired = { ...baseToken, expiresAt: NOW };
    const refreshedByAnotherWriter = {
      ...baseToken,
      accessToken: "callback-access-token",
      refreshToken: "callback-refresh-token",
      expiresAt: NOW + 3600 * 1000,
    };
    await store.set(expired);
    const acquire = store.acquireRefreshLease.bind(store);
    vi.spyOn(store, "acquireRefreshLease").mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args);
      await store.set(refreshedByAnotherWriter);
      return lease;
    });
    const refreshClient = vi.fn();
    const service = new IkasTokenService(store, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient,
      now: () => NOW,
      createLeaseOwnerId: () => "reread-owner",
    });

    expect(await service.get(baseToken.authorizedAppId)).toEqual(refreshedByAnotherWriter);
    expect(refreshClient).not.toHaveBeenCalled();
  });

  it.each([
    ["expiry", { expiresAt: undefined }],
    ["refresh token", { refreshToken: undefined }],
    ["store", { storeName: undefined }],
    ["validated store", { storeName: "bad\\store" }],
  ])("removes an exact legacy record lacking a usable %s and transitions to reconnect", async (_label, patch) => {
    const store = new MemoryTokenStore();
    await store.set({ ...baseToken, ...patch });
    const refreshClient = vi.fn();
    const service = new IkasTokenService(store, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient,
      now: () => NOW,
      createLeaseOwnerId: () => "legacy-cleanup-owner",
    });

    expect(await service.get(baseToken.authorizedAppId)).toBeUndefined();
    expect(await store.get(baseToken.authorizedAppId)).toBeUndefined();
    expect(refreshClient).not.toHaveBeenCalled();
  });

  it("persists a refreshed access token and preserves an unrotated refresh token", async () => {
    const sharedStore = new MemoryTokenStore();
    await sharedStore.set({ ...baseToken, expiresAt: NOW });
    const refreshClient = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        access_token: "access-token-2",
        expires_in: 3600,
        token_type: "Bearer",
      },
    });
    const service = new IkasTokenService(sharedStore, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient,
      now: () => NOW,
    });

    const refreshed = await service.get(baseToken.authorizedAppId);
    const separateReader = new IkasTokenService(sharedStore, { now: () => NOW });

    expect(refreshed).toMatchObject({
      accessToken: "access-token-2",
      refreshToken: "refresh-token-1",
      expiresAt: NOW + 3600 * 1000,
    });
    expect(await separateReader.get(baseToken.authorizedAppId)).toEqual(refreshed);
  });

  it("does not invalidate a durable token after a refresh network failure", async () => {
    const store = new MemoryTokenStore();
    await store.set({ ...baseToken, expiresAt: NOW });
    const deleteSpy = vi.spyOn(store, "delete");
    const service = new IkasTokenService(store, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient: vi.fn().mockRejectedValue(new Error("temporary network failure")),
      now: () => NOW,
    });

    await expect(service.get(baseToken.authorizedAppId)).rejects.toBeInstanceOf(IkasTokenRefreshError);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await store.get(baseToken.authorizedAppId)).toMatchObject({ accessToken: "access-token-1" });
  });

  it("does not invalidate a durable token for an unclassified provider rejection", async () => {
    const store = new MemoryTokenStore();
    await store.set({ ...baseToken, expiresAt: NOW });
    const deleteSpy = vi.spyOn(store, "delete");
    const service = new IkasTokenService(store, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient: vi.fn().mockResolvedValue({ ok: false, status: 503, data: null }),
      now: () => NOW,
    });

    await expect(service.get(baseToken.authorizedAppId)).rejects.toMatchObject({ code: "provider_rejected" });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("does not trust an invalid_grant body on a transient HTTP status", async () => {
    const store = new MemoryTokenStore();
    await store.set({ ...baseToken, expiresAt: NOW });
    const deleteSpy = vi.spyOn(store, "deleteIfMatchesWithRefreshLease");
    const service = new IkasTokenService(store, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient: vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        data: { error: "invalid_grant" },
      }),
      now: () => NOW,
    });

    await expect(service.get(baseToken.authorizedAppId)).rejects.toMatchObject({ code: "provider_rejected" });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await store.get(baseToken.authorizedAppId)).toBeDefined();
  });

  it("invalidates only when the provider confirms the refresh grant is invalid", async () => {
    const store = new MemoryTokenStore();
    await store.set({ ...baseToken, expiresAt: NOW });
    const deleteSpy = vi.spyOn(store, "deleteIfMatchesWithRefreshLease");
    const service = new IkasTokenService(store, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient: vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        data: { error: "invalid_grant" },
      }),
      now: () => NOW,
    });

    expect(await service.get(baseToken.authorizedAppId)).toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ authorizedAppId: baseToken.authorizedAppId }),
      expect.objectContaining({ authorizedAppId: baseToken.authorizedAppId }),
    );
    expect(await store.get(baseToken.authorizedAppId)).toBeUndefined();
  });

  it("does not return a refreshed token when the durable update fails", async () => {
    const backing = new MemoryTokenStore();
    await backing.set({ ...baseToken, expiresAt: NOW });
    const failingStore: TokenStore = {
      get: (authorizedAppId) => backing.get(authorizedAppId),
      set: (token) => backing.set(token),
      delete: (authorizedAppId) => backing.delete(authorizedAppId),
      compareAndSet: vi.fn().mockRejectedValue(new TokenStoreError("backend", "set")),
      deleteIfMatches: (token) => backing.deleteIfMatches(token),
      acquireRefreshLease: (authorizedAppId, ownerId, ttlMs) =>
        backing.acquireRefreshLease(authorizedAppId, ownerId, ttlMs),
      compareAndSetWithRefreshLease: vi.fn().mockRejectedValue(new TokenStoreError("backend", "set")),
      deleteIfMatchesWithRefreshLease: (lease, token) =>
        backing.deleteIfMatchesWithRefreshLease(lease, token),
      releaseRefreshLease: (lease) => backing.releaseRefreshLease(lease),
    };
    const service = new IkasTokenService(failingStore, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        data: { access_token: "access-token-2", expires_in: 3600 },
      }),
      now: () => NOW,
    });

    await expect(service.get(baseToken.authorizedAppId)).rejects.toMatchObject({ code: "backend", operation: "set" });
    expect(await backing.get(baseToken.authorizedAppId)).toMatchObject({ accessToken: "access-token-1" });
  });

  it("does not overwrite a newer callback token when a stale refresh finishes", async () => {
    const store = new MemoryTokenStore();
    const expired = { ...baseToken, expiresAt: NOW };
    const newerCallbackToken = {
      ...baseToken,
      accessToken: "callback-access-token",
      refreshToken: "callback-refresh-token",
      expiresAt: NOW + 7200 * 1000,
    };
    await store.set(expired);
    const service = new IkasTokenService(store, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient: async () => {
        await store.set(newerCallbackToken);
        return {
          ok: true,
          status: 200,
          data: { access_token: "stale-refresh-result", expires_in: 3600 },
        };
      },
      now: () => NOW,
    });

    expect(await service.get(baseToken.authorizedAppId)).toEqual(newerCallbackToken);
    expect(await store.get(baseToken.authorizedAppId)).toEqual(newerCallbackToken);
  });

  it("does not delete a newer callback token after a stale invalid_grant", async () => {
    const store = new MemoryTokenStore();
    const expired = { ...baseToken, expiresAt: NOW };
    const newerCallbackToken = {
      ...baseToken,
      accessToken: "callback-access-token",
      refreshToken: "callback-refresh-token",
      expiresAt: NOW + 7200 * 1000,
    };
    await store.set(expired);
    const service = new IkasTokenService(store, {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshClient: async () => {
        await store.set(newerCallbackToken);
        return { ok: false, status: 400, data: { error: "invalid_grant" } };
      },
      now: () => NOW,
    });

    expect(await service.get(baseToken.authorizedAppId)).toEqual(newerCallbackToken);
    expect(await store.get(baseToken.authorizedAppId)).toEqual(newerCallbackToken);
  });
});

describe("durable verification and configured memory behavior", () => {
  it("rejects a write when the store cannot read matching contents back", async () => {
    const inconsistentStore: TokenStore = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      compareAndSet: vi.fn().mockResolvedValue(false),
      deleteIfMatches: vi.fn().mockResolvedValue(false),
      acquireRefreshLease: vi.fn().mockResolvedValue(undefined),
      compareAndSetWithRefreshLease: vi.fn().mockResolvedValue(false),
      deleteIfMatchesWithRefreshLease: vi.fn().mockResolvedValue(false),
      releaseRefreshLease: vi.fn().mockResolvedValue(false),
    };

    await expect(new IkasTokenService(inconsistentStore).persistAndVerify(baseToken)).rejects.toMatchObject({
      code: "verification_failed",
    });
  });

  it("shares the explicitly non-production memory store across public save/get calls", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("IKAS_TOKEN_STORE_DRIVER", "memory");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    const token = {
      ...baseToken,
      authorizedAppId: "configured-memory-app",
      expiresAt: Date.now() + 60 * 60_000,
    };

    await saveIkasToken(token);

    expect(await getIkasToken(token.authorizedAppId)).toEqual(token);
    vi.unstubAllEnvs();
  });
});
