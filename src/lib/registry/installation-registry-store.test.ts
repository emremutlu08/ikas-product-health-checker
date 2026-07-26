import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createInstallationRegistryStore,
  InstallationRegistryStoreError,
  MAX_REGISTRY_ENTRIES,
  MemoryInstallationRegistryStore,
  RedisRestInstallationRegistryStore,
  REGISTRY_REDIS_KEY,
  type InstallationRegistryRecord,
} from "./installation-registry-store";

const TENANT_A: InstallationRegistryRecord = {
  authorizedAppId: "authorized-app-1",
  merchantId: "merchant-1",
  storeName: "dev-emre2",
};
const TENANT_B: InstallationRegistryRecord = {
  authorizedAppId: "authorized-app-2",
  merchantId: "merchant-2",
  storeName: "dev-other",
};

function expectedDigest(record: InstallationRegistryRecord) {
  return createHash("sha256")
    .update([record.authorizedAppId, record.merchantId].join("\u0000"), "utf8")
    .digest("base64url");
}

/** A minimal in-memory Redis-command executor so the REST store can be exercised without a network. */
function createRedisHarness() {
  const hashes = new Map<string, Map<string, string>>();

  function hash(key: string) {
    let value = hashes.get(key);
    if (!value) {
      value = new Map();
      hashes.set(key, value);
    }
    return value;
  }

  const run = vi.fn(async (command: Array<string | number>): Promise<unknown> => {
    const name = String(command[0]).toUpperCase();
    if (name === "EVAL") {
      const key = String(command[3]);
      const field = String(command[5]);
      const value = String(command[6]);
      const max = Number(command[7]);
      const target = hash(key);
      if (!target.has(field) && target.size >= max) return 0;
      target.set(field, value);
      return 1;
    }
    if (name === "HGETALL") {
      const target = hash(String(command[1]));
      return [...target.entries()].flat();
    }
    if (name === "HGET") {
      return hash(String(command[1])).get(String(command[2])) ?? null;
    }
    if (name === "HDEL") {
      return hash(String(command[1])).delete(String(command[2])) ? 1 : 0;
    }
    throw new Error(`unexpected command ${name}`);
  });

  return { run, hashes };
}

function createFetchFromHarness(harness: ReturnType<typeof createRedisHarness>) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as Array<string | number>;
    const result = await harness.run(command);
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function createRedisStore(overrides: { fetchImpl?: typeof fetch } = {}) {
  const harness = createRedisHarness();
  const store = new RedisRestInstallationRegistryStore({
    url: "https://redis.example.com",
    token: "redis-token",
    fetchImpl: overrides.fetchImpl ?? createFetchFromHarness(harness),
  });
  return { store, harness };
}

describe.each([
  ["memory", () => ({ store: new MemoryInstallationRegistryStore() })],
  ["redis", () => createRedisStore()],
] as const)("InstallationRegistryStore (%s)", (_label, build) => {
  it("registers a validated record, lists it back, and reconciles exact identity", async () => {
    const { store } = build();
    await store.register(TENANT_A);
    expect(await store.list()).toEqual([TENANT_A]);
    expect(await store.has(TENANT_A)).toBe(true);
    expect(await store.has(TENANT_B)).toBe(false);
    expect(await store.has({ ...TENANT_A, storeName: "different-store" })).toBe(false);
  });

  it("stores only the three identity fields, dropping any extra keys", async () => {
    const { store } = build();
    await store.register({
      ...TENANT_A,
      // A hostile caller cannot smuggle a token or email into the registry value.
      accessToken: "secret",
      email: "attacker@example.com",
    } as InstallationRegistryRecord);
    expect(await store.list()).toEqual([TENANT_A]);
  });

  it("idempotently updates an existing tenant without growing the registry", async () => {
    const { store } = build();
    await store.register(TENANT_A);
    await store.register({ ...TENANT_A, storeName: "dev-renamed" });
    expect(await store.list()).toEqual([{ ...TENANT_A, storeName: "dev-renamed" }]);
  });

  it("idempotently unregisters only the exact tenant", async () => {
    const { store } = build();
    await store.register(TENANT_A);
    await store.register(TENANT_B);

    await expect(store.unregister(TENANT_A)).resolves.toBe("deleted");
    await expect(store.unregister(TENANT_A)).resolves.toBe("absent");

    expect(await store.has(TENANT_A)).toBe(false);
    expect(await store.has(TENANT_B)).toBe(true);
    expect(await store.list()).toEqual([TENANT_B]);
  });

  it("rejects an invalid unregister identity without deleting anything", async () => {
    const { store } = build();
    await store.register(TENANT_A);

    await expect(
      store.unregister({ authorizedAppId: TENANT_A.authorizedAppId, merchantId: "" }),
    ).rejects.toMatchObject({ code: "configuration", operation: "unregister" });
    expect(await store.list()).toEqual([TENANT_A]);
  });

  it.each([
    { ...TENANT_A, authorizedAppId: "" },
    { ...TENANT_A, merchantId: "bad merchant" },
    { ...TENANT_A, storeName: "attacker.example\\token" },
    { authorizedAppId: "a", merchantId: "b" } as unknown as InstallationRegistryRecord,
  ])("refuses to register an invalid record %#", async (record) => {
    const { store } = build();
    await expect(store.register(record as InstallationRegistryRecord)).rejects.toBeInstanceOf(
      InstallationRegistryStoreError,
    );
    expect(await store.list()).toEqual([]);
  });
});

describe("RedisRestInstallationRegistryStore", () => {
  it("atomically rejects registration after the durable tenant tombstone", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ result: "tenant_deleted" })));
    const store = createRedisStore({ fetchImpl: fetchMock }).store;

    await expect(store.register(TENANT_A)).rejects.toMatchObject({
      code: "tenant_deleted",
      operation: "register",
    });
    const command = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as string[];
    expect(command.slice(0, 3)).toEqual(["EVAL", expect.any(String), 2]);
    expect(command[4]).toContain("ikas:tenant-deleted:v1:");
    expect(command[4]).not.toContain(TENANT_A.authorizedAppId);
    expect(command[4]).not.toContain(TENANT_A.merchantId);
  });

  it("unregisters with one exact HDEL and rejects malformed Redis results", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 1 }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "1" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    const store = createRedisStore({ fetchImpl: fetchMock }).store;

    await expect(store.unregister(TENANT_A)).resolves.toBe("deleted");
    const command = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(command).toEqual(["HDEL", REGISTRY_REDIS_KEY, expectedDigest(TENANT_A)]);
    await expect(store.unregister(TENANT_A)).rejects.toMatchObject({
      code: "backend",
      operation: "unregister",
    });
  });

  it("keys registry fields by a NUL-separated tenant digest and never by raw ids", async () => {
    const { store, harness } = createRedisStore();
    await store.register(TENANT_A);

    const registryHashes = [...harness.hashes.values()];
    expect(registryHashes).toHaveLength(1);
    const [key] = [...harness.hashes.keys()];
    const fields = registryHashes[0]!;
    const [field] = [...fields.keys()];

    expect(key).toBe(REGISTRY_REDIS_KEY);
    expect(key).not.toContain(TENANT_A.authorizedAppId);
    expect(key).not.toContain(TENANT_A.merchantId);
    expect(field).toBe(expectedDigest(TENANT_A));
    expect(field).not.toContain(TENANT_A.authorizedAppId);
    expect(field).not.toContain(TENANT_A.merchantId);
  });

  it("refuses a new tenant once the registry is full but still updates existing ones", async () => {
    const { store, harness } = createRedisStore();
    const full = new Map<string, string>();
    for (let i = 0; i < MAX_REGISTRY_ENTRIES; i += 1) {
      full.set(`digest-${i}`, JSON.stringify({ ...TENANT_A, storeName: `store-${i}` }));
    }
    harness.hashes.set(REGISTRY_REDIS_KEY, full);

    await expect(store.register(TENANT_B)).rejects.toMatchObject({ code: "capacity" });
    expect(full.size).toBe(MAX_REGISTRY_ENTRIES);
  });

  it("skips corrupt and cross-digest records on list rather than aborting the whole run", async () => {
    const { store, harness } = createRedisStore();
    await store.register(TENANT_A);
    await store.register(TENANT_B);

    const fields = [...harness.hashes.values()][0]!;
    fields.set("corrupt-json", "{not json");
    fields.set(expectedDigest({ ...TENANT_A, authorizedAppId: "x" }), JSON.stringify(TENANT_A));

    const listed = await store.list();
    expect(listed).toEqual(expect.arrayContaining([TENANT_A, TENANT_B]));
    expect(listed).toHaveLength(2);
  });

  it("wraps a Redis transport failure in a generic typed error", async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const store = new RedisRestInstallationRegistryStore({
      url: "https://redis.example.com",
      token: "redis-token",
      fetchImpl: failingFetch,
    });
    await expect(store.list()).rejects.toMatchObject({ code: "backend" });
  });

  it("times out a slow Redis read with a bounded abort", async () => {
    const slowFetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const store = new RedisRestInstallationRegistryStore({
      url: "https://redis.example.com",
      token: "redis-token",
      fetchImpl: slowFetch,
      requestTimeoutMs: 5,
    });
    await expect(store.list()).rejects.toBeInstanceOf(InstallationRegistryStoreError);
  });

  it("rejects an insecure endpoint at construction", () => {
    expect(
      () => new RedisRestInstallationRegistryStore({ url: "http://redis.example.com", token: "t" }),
    ).toThrow(InstallationRegistryStoreError);
  });
});

describe("createInstallationRegistryStore", () => {
  it("builds a memory store under the memory driver in test", () => {
    const store = createInstallationRegistryStore({
      env: { NODE_ENV: "test", IKAS_REGISTRY_STORE_DRIVER: "memory" },
    });
    expect(store).toBeInstanceOf(MemoryInstallationRegistryStore);
  });

  it("builds a redis store from Upstash credentials", () => {
    const store = createInstallationRegistryStore({
      env: {
        NODE_ENV: "production",
        UPSTASH_REDIS_REST_URL: "https://redis.example.com",
        UPSTASH_REDIS_REST_TOKEN: "redis-token",
      },
    });
    expect(store).toBeInstanceOf(RedisRestInstallationRegistryStore);
  });

  it("refuses the memory driver outside development or test", () => {
    expect(() =>
      createInstallationRegistryStore({
        env: { NODE_ENV: "production", IKAS_REGISTRY_STORE_DRIVER: "memory" },
      }),
    ).toThrow(InstallationRegistryStoreError);
  });

  it("fails closed when no credentials are configured in production", () => {
    expect(() => createInstallationRegistryStore({ env: { NODE_ENV: "production" } })).toThrow(
      InstallationRegistryStoreError,
    );
  });
});
