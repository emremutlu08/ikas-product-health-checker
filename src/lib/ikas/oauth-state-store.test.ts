import { describe, expect, it, vi } from "vitest";
import {
  createOAuthStateStore,
  generateOAuthState,
  MemoryOAuthStateStore,
  OAUTH_STATE_TTL_MS,
  OAuthStateStoreError,
  readOAuthStateCreatedAt,
  RedisRestOAuthStateStore,
} from "./oauth-state-store";

const NOW = Date.parse("2026-07-13T10:00:00.000Z");

type RedisEntry = {
  value: string;
  expiresAt: number;
};

function jsonResponse(result: unknown, status = 200) {
  return new Response(JSON.stringify({ result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createRedisRestFake(initialNow = NOW) {
  let currentTime = initialNow;
  let backendFailure = false;
  const entries = new Map<string, RedisEntry>();
  const commands: Array<Array<string | number>> = [];

  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (backendFailure) {
      return new Response("BACKEND_DIAGNOSTIC_SENTINEL", { status: 503 });
    }

    const command = JSON.parse(String(init?.body)) as Array<string | number>;
    commands.push(command);

    if (command[0] === "SET") {
      const key = String(command[1]);
      const current = entries.get(key);
      if (current && current.expiresAt <= currentTime) entries.delete(key);
      if (command[5] === "NX" && entries.has(key)) return jsonResponse(null);
      entries.set(key, {
        value: String(command[2]),
        expiresAt: currentTime + Number(command[4]),
      });
      return jsonResponse("OK");
    }

    if (command[0] === "EVAL") {
      const key = String(command[3]);
      const tombstone = String(command[4]);
      const entry = entries.get(key);
      if (entry && entry.expiresAt <= currentTime) entries.delete(key);
      const active = entries.get(key);
      if (!active) return jsonResponse([0, ""]);
      if (active.value === tombstone) return jsonResponse([2, ""]);
      entries.set(key, {
        value: tombstone,
        expiresAt: currentTime + Number(command[5]),
      });
      return jsonResponse([1, active.value]);
    }

    return jsonResponse(null, 400);
  });

  return {
    commands,
    entries,
    fetchImpl,
    now: () => currentTime,
    advance(durationMs: number) {
      currentTime += durationMs;
    },
    failBackend() {
      backendFailure = true;
    },
  };
}

describe("OAuth state generation", () => {
  it("generates unique timestamp-bound states with 256 bits of random entropy", () => {
    const first = generateOAuthState(NOW);
    const second = generateOAuthState(NOW);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.[0-9a-z]{1,11}$/);
    expect(first.split(".")[1]).toHaveLength(43);
    expect(readOAuthStateCreatedAt(first)).toBe(NOW);
  });
});

describe("RedisRestOAuthStateStore", () => {
  it("persists only the normalized binding with a bounded TTL under a hashed lookup key", async () => {
    const redis = createRedisRestFake();
    const store = new RedisRestOAuthStateStore({
      url: "https://redis.example.com",
      token: "test-token",
      fetchImpl: redis.fetchImpl,
      now: redis.now,
    });
    const state = generateOAuthState(NOW);

    await store.persist(state, { storeName: "dev-emre2", createdAt: NOW }, OAUTH_STATE_TTL_MS);

    expect(redis.commands).toHaveLength(1);
    const command = redis.commands[0];
    expect(command).toEqual([
      "SET",
      expect.stringMatching(/^ikas:oauth-state:v1:[A-Za-z0-9_-]{43}$/),
      JSON.stringify({ storeName: "dev-emre2", createdAt: NOW }),
      "PX",
      OAUTH_STATE_TTL_MS,
      "NX",
    ]);
    expect(String(command[1])).not.toContain(state);
    expect(Object.keys(JSON.parse(String(command[2]))).sort()).toEqual(["createdAt", "storeName"]);
    expect(command[4]).toBeLessThanOrEqual(5 * 60_000);

    await expect(
      store.persist(state, { storeName: "dev-emre2", createdAt: NOW }, OAUTH_STATE_TTL_MS + 1),
    ).rejects.toMatchObject({ code: "configuration", operation: "persist" });
  });

  it("atomically returns the record once and reports a concurrent replay", async () => {
    const redis = createRedisRestFake();
    const store = new RedisRestOAuthStateStore({
      url: "https://redis.example.com",
      token: "test-token",
      fetchImpl: redis.fetchImpl,
      now: redis.now,
    });
    const state = generateOAuthState(NOW);
    await store.persist(state, { storeName: "dev-emre2", createdAt: NOW }, OAUTH_STATE_TTL_MS);

    const results = await Promise.all([store.consume(state), store.consume(state)]);

    expect(results.map((result) => result.status).sort()).toEqual(["consumed", "replayed"]);
    expect(results.find((result) => result.status === "consumed")).toEqual({
      status: "consumed",
      record: { storeName: "dev-emre2", createdAt: NOW },
    });
    const consumeCommand = redis.commands.find((command) => command[0] === "EVAL");
    expect(consumeCommand?.[1]).toContain("redis.call('GET', KEYS[1])");
    expect(consumeCommand?.[1]).toContain("redis.call('DEL', KEYS[1])");
    expect(consumeCommand?.[1]).toContain("redis.call('SET', KEYS[1]");
  });

  it("distinguishes an unknown state from an expired issued state", async () => {
    const redis = createRedisRestFake();
    const store = new RedisRestOAuthStateStore({
      url: "https://redis.example.com",
      token: "test-token",
      fetchImpl: redis.fetchImpl,
      now: redis.now,
    });
    const issuedState = generateOAuthState(NOW);
    await store.persist(issuedState, { storeName: "dev-emre2", createdAt: NOW }, OAUTH_STATE_TTL_MS);

    const unknownState = generateOAuthState(NOW);
    expect(await store.consume(unknownState)).toEqual({ status: "missing" });

    redis.advance(OAUTH_STATE_TTL_MS);
    expect(await store.consume(issuedState)).toEqual({ status: "expired" });
  });

  it("returns a fixed safe error when the consume backend fails", async () => {
    const redis = createRedisRestFake();
    const store = new RedisRestOAuthStateStore({
      url: "https://redis.example.com",
      token: "test-token",
      fetchImpl: redis.fetchImpl,
      now: redis.now,
    });
    redis.failBackend();

    const error = await store.consume(generateOAuthState(NOW)).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(OAuthStateStoreError);
    expect(error).toMatchObject({ code: "backend", operation: "consume" });
    expect(String(error)).not.toContain("BACKEND_DIAGNOSTIC_SENTINEL");
    expect(String(error)).not.toContain("test-token");
  });
});

describe("MemoryOAuthStateStore", () => {
  it("is an injectable local fake with the same one-time and expiry behavior", async () => {
    let now = NOW;
    const store = new MemoryOAuthStateStore(() => now);
    const state = generateOAuthState(now);
    await store.persist(state, { storeName: "dev-emre2", createdAt: now }, OAUTH_STATE_TTL_MS);

    expect(await store.consume(state)).toMatchObject({ status: "consumed" });
    expect(await store.consume(state)).toEqual({ status: "replayed" });

    const expiringState = generateOAuthState(now);
    await store.persist(
      expiringState,
      { storeName: "dev-emre2", createdAt: now },
      OAUTH_STATE_TTL_MS,
    );
    now += OAUTH_STATE_TTL_MS;
    expect(await store.consume(expiringState)).toEqual({ status: "expired" });
  });
});

describe("createOAuthStateStore", () => {
  it("fails closed in production without one complete Redis credential pair", () => {
    expect(() => createOAuthStateStore({ env: { NODE_ENV: "production" } })).toThrowError(
      OAuthStateStoreError,
    );
    expect(() =>
      createOAuthStateStore({
        env: { NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "https://redis.example.com" },
      }),
    ).toThrowError(OAuthStateStoreError);
    expect(() =>
      createOAuthStateStore({
        env: {
          NODE_ENV: "production",
          UPSTASH_REDIS_REST_URL: "https://redis.example.com",
          KV_REST_API_TOKEN: "mixed-token",
        },
      }),
    ).toThrowError(OAuthStateStoreError);
    expect(() =>
      createOAuthStateStore({
        env: { NODE_ENV: "production", IKAS_TOKEN_STORE_DRIVER: "memory" },
      }),
    ).toThrowError(OAuthStateStoreError);
  });

  it("accepts either existing Redis REST credential family and uses memory only outside production", () => {
    expect(
      createOAuthStateStore({
        env: {
          NODE_ENV: "production",
          UPSTASH_REDIS_REST_URL: "https://redis.example.com",
          UPSTASH_REDIS_REST_TOKEN: "test-token",
        },
      }),
    ).toBeInstanceOf(RedisRestOAuthStateStore);
    expect(
      createOAuthStateStore({
        env: {
          NODE_ENV: "production",
          KV_REST_API_URL: "https://redis.example.com",
          KV_REST_API_TOKEN: "test-token",
        },
      }),
    ).toBeInstanceOf(RedisRestOAuthStateStore);
    expect(createOAuthStateStore({ env: { NODE_ENV: "development" } })).toBeInstanceOf(
      MemoryOAuthStateStore,
    );
    expect(createOAuthStateStore({ env: { NODE_ENV: "test" } })).toBeInstanceOf(
      MemoryOAuthStateStore,
    );
  });
});
