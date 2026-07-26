import { describe, expect, it, vi } from "vitest";
import {
  createInterestStore,
  InterestStoreError,
  isInterestIntent,
  MemoryInterestStore,
  RedisRestInterestStore,
} from "./interest-store";

const credentials = {
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "redis-token",
};

const tenant = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  intent: "low_stock_threshold_monitoring",
  createdAt: 1_784_000_000_000,
} as const;

function redisResponse(result: unknown) {
  return new Response(JSON.stringify({ result }), { status: 200 });
}

describe("interest intents", () => {
  it("accepts only the allowlisted paid-feature intents", () => {
    expect(isInterestIntent("low_stock_threshold_monitoring")).toBe(true);
    expect(isInterestIntent("arbitrary_intent")).toBe(false);
    expect(isInterestIntent(undefined)).toBe(false);
  });
});

describe("RedisRestInterestStore", () => {
  it("persists only tenant-bound signal fields and never tokens or product data", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse("OK"));
    const store = new RedisRestInterestStore({
      url: credentials.UPSTASH_REDIS_REST_URL,
      token: credentials.UPSTASH_REDIS_REST_TOKEN,
      fetchImpl: fetchMock,
    });

    await expect(store.record(tenant)).resolves.toBe("recorded");

    const command = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as string[];
    expect(command.slice(0, 3)).toEqual(["EVAL", expect.any(String), 2]);
    expect(command[1]).toContain("'NX'");
    expect(JSON.parse(command[5])).toEqual({
      authorizedAppId: "app-1",
      merchantId: "merchant-1",
      intent: "low_stock_threshold_monitoring",
      createdAt: 1_784_000_000_000,
    });
    // The raw tenant id must not leak into the key space.
    expect(command[3]).not.toContain("app-1");
    expect(command[3]).toContain("low_stock_threshold_monitoring");
    expect(command[4]).not.toContain("app-1");
    expect(command[4]).not.toContain("merchant-1");
  });

  it("reports an existing signal as already recorded instead of overwriting it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse(null));
    const store = new RedisRestInterestStore({
      url: credentials.UPSTASH_REDIS_REST_URL,
      token: credentials.UPSTASH_REDIS_REST_TOKEN,
      fetchImpl: fetchMock,
    });

    await expect(store.record(tenant)).resolves.toBe("already_recorded");
  });

  it("atomically deletes exact allowlisted interest keys after tenant verification", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redisResponse(1))
      .mockResolvedValueOnce(redisResponse(0))
      .mockResolvedValueOnce(redisResponse(-1))
      .mockResolvedValueOnce(redisResponse(-2))
      .mockResolvedValueOnce(redisResponse("1"));
    const store = new RedisRestInterestStore({
      url: credentials.UPSTASH_REDIS_REST_URL,
      token: credentials.UPSTASH_REDIS_REST_TOKEN,
      fetchImpl: fetchMock,
    });
    const identity = {
      authorizedAppId: tenant.authorizedAppId,
      merchantId: tenant.merchantId,
    };

    await expect(store.deleteTenant(identity)).resolves.toBe("deleted");
    const command = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(command.slice(0, 3)).toEqual(["EVAL", expect.any(String), 1]);
    expect(command[3]).toContain("ikas:interest:v1:low_stock_threshold_monitoring:");
    expect(String(command[3])).not.toContain(tenant.authorizedAppId);
    expect(String(command[1])).not.toContain("SCAN");
    expect(String(command[1])).not.toContain("then;");
    expect(String(command[1])).not.toContain("do;");
    expect(command.slice(4)).toEqual([identity.authorizedAppId, identity.merchantId]);
    await expect(store.deleteTenant(identity)).resolves.toBe("absent");
    await expect(store.deleteTenant(identity)).rejects.toMatchObject({ code: "corrupt_record" });
    await expect(store.deleteTenant(identity)).rejects.toMatchObject({ code: "tenant_mismatch" });
    await expect(store.deleteTenant(identity)).rejects.toMatchObject({ code: "backend" });
  });

  it("maps an unavailable backend to a sanitized store error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 500 }));
    const store = new RedisRestInterestStore({
      url: credentials.UPSTASH_REDIS_REST_URL,
      token: credentials.UPSTASH_REDIS_REST_TOKEN,
      fetchImpl: fetchMock,
    });

    await expect(store.record(tenant)).rejects.toMatchObject({
      name: "InterestStoreError",
      code: "backend",
    });
  });

  it("rejects hostile or unknown record input before touching the backend", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const store = new RedisRestInterestStore({
      url: credentials.UPSTASH_REDIS_REST_URL,
      token: credentials.UPSTASH_REDIS_REST_TOKEN,
      fetchImpl: fetchMock,
    });

    await expect(store.record({ ...tenant, intent: "spoofed" as never })).rejects.toBeInstanceOf(InterestStoreError);
    await expect(store.record({ ...tenant, authorizedAppId: "" })).rejects.toBeInstanceOf(InterestStoreError);
    await expect(store.record({ ...tenant, merchantId: "bad\u0000id" })).rejects.toBeInstanceOf(InterestStoreError);
    await expect(store.record({ ...tenant, createdAt: -1 })).rejects.toBeInstanceOf(InterestStoreError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("MemoryInterestStore", () => {
  it("is idempotent per authorizedAppId and intent, and partitions other tenants", async () => {
    const store = new MemoryInterestStore();

    await expect(store.record(tenant)).resolves.toBe("recorded");
    await expect(store.record({ ...tenant, createdAt: tenant.createdAt + 1000 })).resolves.toBe("already_recorded");
    await expect(store.record({ ...tenant, authorizedAppId: "app-2" })).resolves.toBe("recorded");
  });

  it("deletes only a matching tenant and fails closed on a merchant mismatch", async () => {
    const store = new MemoryInterestStore();
    const other = { ...tenant, authorizedAppId: "app-2", merchantId: "merchant-2" };
    await store.record(tenant);
    await store.record(other);

    await expect(
      store.deleteTenant({
        authorizedAppId: tenant.authorizedAppId,
        merchantId: "merchant-wrong",
      }),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });
    await expect(
      store.deleteTenant({
        authorizedAppId: tenant.authorizedAppId,
        merchantId: tenant.merchantId,
      }),
    ).resolves.toBe("deleted");
    await expect(
      store.deleteTenant({
        authorizedAppId: tenant.authorizedAppId,
        merchantId: tenant.merchantId,
      }),
    ).resolves.toBe("absent");
    await expect(store.record(other)).resolves.toBe("already_recorded");
  });
});

describe("createInterestStore", () => {
  it("uses the configured Upstash Redis REST credentials", () => {
    expect(createInterestStore({ env: credentials })).toBeInstanceOf(RedisRestInterestStore);
  });

  it("fails closed instead of pretending to record when no durable backend is configured", () => {
    for (const environment of ["development", "test", "production", undefined]) {
      expect(() => createInterestStore({ env: { NODE_ENV: environment } })).toThrow(InterestStoreError);
    }
  });
});
