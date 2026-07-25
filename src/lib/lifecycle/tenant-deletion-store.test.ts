import { describe, expect, it, vi } from "vitest";
import {
  createTenantDeletionStore,
  MemoryTenantDeletionStore,
  RedisRestTenantDeletionStore,
  TenantDeletionStoreError,
} from "./tenant-deletion-store";

const tenant = {
  authorizedAppId: "authorized-app-1",
  merchantId: "merchant-1",
} as const;

function redisResponse(result: unknown) {
  return Response.json({ result });
}

describe("RedisRestTenantDeletionStore", () => {
  it("durably and idempotently marks deletion without leaking raw tenant ids", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redisResponse(1))
      .mockResolvedValueOnce(redisResponse(0));
    const store = new RedisRestTenantDeletionStore({
      url: "https://redis.example.test",
      token: "redis-token",
      fetchImpl,
    });

    await expect(store.markDeleted(tenant)).resolves.toBe("marked");
    await expect(store.markDeleted(tenant)).resolves.toBe("already_marked");

    const command = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as string[];
    expect(command.slice(0, 3)).toEqual(["EVAL", expect.any(String), 1]);
    expect(command[3]).toContain("ikas:tenant-deleted:v1:");
    expect(command[3]).not.toContain(tenant.authorizedAppId);
    expect(command[3]).not.toContain(tenant.merchantId);
    expect(command[4]).not.toContain(tenant.authorizedAppId);
    expect(command[4]).not.toContain(tenant.merchantId);
    expect(String(command[1])).toContain("redis.call('GET', KEYS[1])");
    expect(String(command[1])).toContain("redis.call('SET', KEYS[1], ARGV[1])");
  });

  it("fails closed when an existing installation barrier belongs to another merchant", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redisResponse(-1));
    const store = new RedisRestTenantDeletionStore({
      url: "https://redis.example.test",
      token: "redis-token",
      fetchImpl,
    });

    await expect(
      store.markDeleted({ ...tenant, merchantId: "merchant-2" }),
    ).rejects.toMatchObject({
      code: "identity_mismatch",
      operation: "mark_deleted",
    });
  });

  it("rejects invalid identity before Redis and maps backend failures to sanitized errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const store = new RedisRestTenantDeletionStore({
      url: "https://redis.example.test",
      token: "redis-token",
      fetchImpl,
    });

    await expect(
      store.markDeleted({ authorizedAppId: "", merchantId: tenant.merchantId }),
    ).rejects.toMatchObject({
      name: "TenantDeletionStoreError",
      code: "configuration",
      operation: "mark_deleted",
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const failingStore = new RedisRestTenantDeletionStore({
      url: "https://redis.example.test",
      token: "redis-token",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 503 })),
    });
    await expect(failingStore.markDeleted(tenant)).rejects.toEqual(
      new TenantDeletionStoreError("backend", "mark_deleted"),
    );
  });
});

describe("local tenant deletion store", () => {
  it("preserves the same idempotent marker contract in memory", async () => {
    const store = new MemoryTenantDeletionStore();
    await expect(store.markDeleted(tenant)).resolves.toBe("marked");
    await expect(store.markDeleted(tenant)).resolves.toBe("already_marked");
    await expect(
      store.markDeleted({ ...tenant, merchantId: "merchant-2" }),
    ).rejects.toMatchObject({ code: "identity_mismatch", operation: "mark_deleted" });
  });

  it("constructs the production store only from durable Redis credentials", () => {
    expect(
      createTenantDeletionStore({
        env: {
          UPSTASH_REDIS_REST_URL: "https://redis.example.test",
          UPSTASH_REDIS_REST_TOKEN: "redis-token",
        },
      }),
    ).toBeInstanceOf(RedisRestTenantDeletionStore);
    expect(() => createTenantDeletionStore({ env: {} })).toThrow(TenantDeletionStoreError);
  });
});
