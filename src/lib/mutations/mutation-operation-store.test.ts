import { describe, expect, it } from "vitest";
import {
  createMutationOperationStore,
  MemoryMutationOperationStore,
  MutationOperationStoreError,
  RedisRestMutationOperationStore,
  type MutationOperationStore,
} from "./mutation-operation-store";
import { buildSkuPayload, TEST_TENANT } from "./mutation-fixtures";
import type { MutationSettlement } from "./mutation-operation";

const otherTenant = { authorizedAppId: "authorized-app-2", merchantId: "merchant-2" } as const;

const succeeded: MutationSettlement = {
  status: "succeeded",
  completedAt: 1_753_000_300_000,
  verifiedValue: "NEW-SKU",
};

function claimAt(payload = buildSkuPayload()) {
  return payload.createdAt + 1_000;
}

describe("MemoryMutationOperationStore", () => {
  async function prepared(store: MutationOperationStore = new MemoryMutationOperationStore()) {
    const payload = buildSkuPayload();
    expect(await store.prepare(TEST_TENANT, payload)).toBe("prepared");
    return { store, payload };
  }

  it("refuses a duplicate preparation of the same operation id", async () => {
    const { store, payload } = await prepared();

    expect(await store.prepare(TEST_TENANT, payload)).toBe("already_exists");
  });

  it("admits exactly one claim and reports every later attempt as a replay", async () => {
    const { store, payload } = await prepared();

    const first = await store.claim(TEST_TENANT, payload.operationId, claimAt());
    const second = await store.claim(TEST_TENANT, payload.operationId, claimAt() + 1);

    expect(first.outcome).toBe("claimed");
    expect(second).toEqual({ outcome: "replay" });
  });

  it("refuses a claim at or after the expiry instant", async () => {
    const { store, payload } = await prepared();

    expect(await store.claim(TEST_TENANT, payload.operationId, payload.expiresAt)).toEqual({
      outcome: "expired",
    });
  });

  it("never resolves another tenant's operation id", async () => {
    const { store, payload } = await prepared();

    expect(await store.get(otherTenant, payload.operationId)).toBeUndefined();
    expect(await store.claim(otherTenant, payload.operationId, claimAt())).toEqual({
      outcome: "missing",
    });
  });

  it("settles only an executing operation and keeps the settlement durable", async () => {
    const { store, payload } = await prepared();

    expect(await store.settle(TEST_TENANT, payload.operationId, succeeded)).toBe("not_executing");
    await store.claim(TEST_TENANT, payload.operationId, claimAt());
    expect(await store.settle(TEST_TENANT, payload.operationId, succeeded)).toBe("settled");
    expect(await store.settle(TEST_TENANT, payload.operationId, succeeded)).toBe("not_executing");

    const record = await store.get(TEST_TENANT, payload.operationId);
    expect(record).toMatchObject({ status: "succeeded", settlement: succeeded });
  });

  it("rejects a confirmation window longer than the hard ceiling", async () => {
    const store = new MemoryMutationOperationStore();

    await expect(
      store.prepare(
        TEST_TENANT,
        buildSkuPayload({ createdAt: 1_000_000, expiresAt: 1_000_000 + 16 * 60 * 1000 }),
      ),
    ).rejects.toBeInstanceOf(MutationOperationStoreError);
  });

  it("lists recent operations newest first and removes them all on tenant deletion", async () => {
    const store = new MemoryMutationOperationStore();
    await store.prepare(TEST_TENANT, buildSkuPayload({ operationId: "op-a", createdAt: 1_000 , expiresAt: 61_000 }));
    await store.prepare(TEST_TENANT, buildSkuPayload({ operationId: "op-b", createdAt: 2_000, expiresAt: 62_000 }));

    expect(await store.listRecent(TEST_TENANT, 10)).toEqual(["op-b", "op-a"]);
    expect(await store.deleteTenant(TEST_TENANT)).toBe("deleted");
    expect(await store.get(TEST_TENANT, "op-a")).toBeUndefined();
    expect(await store.deleteTenant(TEST_TENANT)).toBe("absent");
  });
});

type StubCall = { command: unknown[] };

function redisStore(responder: (command: unknown[]) => unknown) {
  const calls: StubCall[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body)) as unknown[];
    calls.push({ command });
    return new Response(JSON.stringify({ result: responder(command) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return {
    calls,
    store: new RedisRestMutationOperationStore({
      url: "https://redis.example.com",
      token: "token",
      fetchImpl,
    }),
  };
}

describe("RedisRestMutationOperationStore", () => {
  it("passes the deletion barrier key to every mutating script and surfaces a deleted tenant", async () => {
    const { calls, store } = redisStore(() => "tenant_deleted");

    await expect(store.prepare(TEST_TENANT, buildSkuPayload())).rejects.toMatchObject({
      code: "tenant_deleted",
    });
    const [prepare] = calls;
    expect(prepare!.command[0]).toBe("EVAL");
    expect(prepare!.command[2]).toBe(3);
    // KEYS[2] is the barrier, so the check happens inside the same script as the write.
    expect(String(prepare!.command[4])).toContain("ikas:tenant-deleted");
    expect(String(prepare!.command[1])).toContain("EXISTS', KEYS[2]");
  });

  it("keeps the payload out of Lua by storing it as one opaque field", async () => {
    const { calls, store } = redisStore(() => 1);

    await store.prepare(TEST_TENANT, buildSkuPayload());

    const script = String(calls[0]!.command[1]);
    expect(script).toContain("HSET");
    expect(script).not.toContain("cjson");
  });

  it("maps a claim result array onto the parsed payload", async () => {
    const payload = buildSkuPayload();
    const { store } = redisStore((command) =>
      String(command[1]).includes("'claimed'") ? ["claimed", JSON.stringify(payload)] : 1,
    );

    await expect(store.claim(TEST_TENANT, payload.operationId, claimAt())).resolves.toEqual({
      outcome: "claimed",
      payload,
    });
  });

  it("treats a payload that no longer matches the schema as a corrupt record", async () => {
    const { store } = redisStore(() => ["claimed", JSON.stringify({ kind: "sku_change" })]);

    await expect(store.claim(TEST_TENANT, "operation-1", claimAt())).rejects.toMatchObject({
      code: "corrupt_record",
    });
  });

  it("raises identity_mismatch rather than returning another tenant's record", async () => {
    const { store } = redisStore(() => ["identity_mismatch"]);

    await expect(store.get(TEST_TENANT, "operation-1")).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });

  it("refuses a terminal record whose settlement is missing", async () => {
    const { store } = redisStore(() => [
      "found",
      "succeeded",
      JSON.stringify(buildSkuPayload()),
      "1753000200000",
      "",
    ]);

    await expect(store.get(TEST_TENANT, "operation-1")).rejects.toMatchObject({
      code: "corrupt_record",
    });
  });

  it("refuses a settlement that disagrees with the stored status", async () => {
    const { store } = redisStore(() => [
      "found",
      "succeeded",
      JSON.stringify(buildSkuPayload()),
      "1753000200000",
      JSON.stringify({ status: "rejected", completedAt: 1, reason: "stale_value" }),
    ]);

    await expect(store.get(TEST_TENANT, "operation-1")).rejects.toMatchObject({
      code: "corrupt_record",
    });
  });

  it("maps an upstream failure to a backend error without leaking the response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const store = new RedisRestMutationOperationStore({
      url: "https://redis.example.com",
      token: "token",
      fetchImpl,
    });

    await expect(store.get(TEST_TENANT, "operation-1")).rejects.toMatchObject({ code: "backend" });
  });

  it("refuses an insecure endpoint", () => {
    expect(
      () => new RedisRestMutationOperationStore({ url: "http://redis.example.com", token: "t" }),
    ).toThrow(MutationOperationStoreError);
  });
});

describe("createMutationOperationStore", () => {
  it("never falls back to memory outside development and test", () => {
    expect(() =>
      createMutationOperationStore({
        env: { NODE_ENV: "production", IKAS_MUTATION_STORE_DRIVER: "memory" },
      }),
    ).toThrow(MutationOperationStoreError);
  });

  it("requires redis credentials when no driver is configured", () => {
    expect(() => createMutationOperationStore({ env: { NODE_ENV: "production" } })).toThrow(
      MutationOperationStoreError,
    );
  });

  it("refuses a half-configured credential pair", () => {
    expect(() =>
      createMutationOperationStore({
        env: { NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "https://redis.example.com" },
      }),
    ).toThrow(MutationOperationStoreError);
  });

  it("builds a redis store from the production credential pair", () => {
    const store = createMutationOperationStore({
      env: {
        NODE_ENV: "production",
        UPSTASH_REDIS_REST_URL: "https://redis.example.com",
        UPSTASH_REDIS_REST_TOKEN: "token",
      },
    });

    expect(store).toBeInstanceOf(RedisRestMutationOperationStore);
  });
});
