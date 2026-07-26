import { describe, expect, it } from "vitest";
import {
  AlertStoreError,
  createAlertOutboxStore,
  createLowStockAlertStore,
  MAX_DELIVERY_ATTEMPTS,
  MemoryAlertOutboxStore,
  MemoryLowStockAlertStore,
  parseAlertStateRecord,
  RedisAlertOutboxStore,
  RedisLowStockAlertStore,
  serializeAlertStateRecord,
} from "./alert-store";

const tenant = { authorizedAppId: "app-1", merchantId: "merchant-1" } as const;
const otherTenant = { authorizedAppId: "app-2", merchantId: "merchant-2" } as const;
const NOW = 1_753_000_000_000;

const record = {
  state: {
    "product-1|variant-1|location-1": {
      side: "below" as const,
      firstSeen: NOW,
      lastSeen: NOW,
      lastNotifiedAt: NOW,
      lastNotifiedSide: "below" as const,
    },
  },
  lastScanId: "scan-1",
};

describe("alert state serialization", () => {
  it("round-trips a record", () => {
    expect(parseAlertStateRecord(serializeAlertStateRecord(record))).toEqual(record);
  });

  it("refuses anything that is not exactly the current record shape", () => {
    for (const raw of [
      "not json",
      JSON.stringify({ state: {} }),
      JSON.stringify({ version: 2, state: {} }),
      JSON.stringify({ version: 1, state: [] }),
      JSON.stringify({ version: 1, state: { a: { side: "sideways", firstSeen: 1, lastSeen: 1 } } }),
      JSON.stringify({ version: 1, state: { a: { side: "below", firstSeen: 0, lastSeen: 1 } } }),
      JSON.stringify({ version: 1, state: { a: { side: "below", firstSeen: 1 } } }),
      JSON.stringify({ version: 1, lastScanId: 5, state: {} }),
    ]) {
      expect(() => parseAlertStateRecord(raw), raw).toThrow(AlertStoreError);
    }
  });
});

describe("MemoryLowStockAlertStore", () => {
  it("starts empty, persists a write and never crosses tenants", async () => {
    const store = new MemoryLowStockAlertStore();

    await expect(store.read(tenant)).resolves.toEqual({ state: {} });
    await store.write(tenant, record);
    await expect(store.read(tenant)).resolves.toEqual(record);
    await expect(store.read(otherTenant)).resolves.toEqual({ state: {} });

    await expect(store.deleteTenant(tenant)).resolves.toBe("deleted");
    await expect(store.deleteTenant(tenant)).resolves.toBe("absent");
  });
});

describe("MemoryAlertOutboxStore", () => {
  it("admits one claim, blocks a concurrent worker and never re-sends", async () => {
    const store = new MemoryAlertOutboxStore();

    await expect(store.claim(tenant, "alert/scan-1/low-stock", NOW, 60_000)).resolves.toEqual({
      outcome: "claimed",
      attempts: 1,
    });
    await expect(store.claim(tenant, "alert/scan-1/low-stock", NOW + 1, 60_000)).resolves.toMatchObject(
      { outcome: "in_flight" },
    );

    await store.markSent(tenant, "alert/scan-1/low-stock");
    await expect(
      store.claim(tenant, "alert/scan-1/low-stock", NOW + 10_000_000, 60_000),
    ).resolves.toMatchObject({ outcome: "already_sent" });
  });

  it("holds a failed delivery in backoff and then allows a bounded retry", async () => {
    const store = new MemoryAlertOutboxStore();
    await store.claim(tenant, "k", NOW, 60_000);
    await store.markFailed(tenant, "k", NOW + 900_000);

    await expect(store.claim(tenant, "k", NOW + 1_000, 60_000)).resolves.toMatchObject({
      outcome: "backoff",
    });
    await expect(store.claim(tenant, "k", NOW + 900_000, 60_000)).resolves.toEqual({
      outcome: "claimed",
      attempts: 2,
    });
  });

  it("stops retrying once the attempt budget is spent", async () => {
    const store = new MemoryAlertOutboxStore();
    let now = NOW;
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await store.claim(tenant, "k", now, 1_000);
      await store.markFailed(tenant, "k", now);
      now += 10_000;
    }

    await expect(store.claim(tenant, "k", now, 1_000)).resolves.toMatchObject({
      outcome: "exhausted",
    });
  });

  it("keeps one tenant's delivery record out of another's", async () => {
    const store = new MemoryAlertOutboxStore();
    await store.claim(tenant, "k", NOW, 60_000);
    await store.markSent(tenant, "k");

    await expect(store.claim(otherTenant, "k", NOW, 60_000)).resolves.toMatchObject({
      outcome: "claimed",
    });
  });
});

function redisStore(responder: (command: unknown[]) => unknown) {
  const calls: unknown[][] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body)) as unknown[];
    calls.push(command);
    return new Response(JSON.stringify({ result: responder(command) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, options: { url: "https://redis.example.com", token: "t", fetchImpl } };
}

describe("Redis alert stores", () => {
  it("checks the deletion barrier inside the state write itself", async () => {
    const { calls, options } = redisStore(() => 1);
    await new RedisLowStockAlertStore(options).write(tenant, record);

    expect(calls[0]![0]).toBe("EVAL");
    expect(String(calls[0]![1])).toContain("EXISTS', KEYS[2]");
    expect(String(calls[0]![4])).toContain("ikas:tenant-deleted");
  });

  it("refuses to write for a deleted tenant", async () => {
    const { options } = redisStore(() => "tenant_deleted");

    await expect(new RedisLowStockAlertStore(options).write(tenant, record)).rejects.toMatchObject({
      code: "tenant_deleted",
    });
    await expect(
      new RedisAlertOutboxStore(options).claim(tenant, "k", NOW, 1_000),
    ).rejects.toMatchObject({ code: "tenant_deleted" });
  });

  it("returns an empty record rather than failing when nothing is stored", async () => {
    const { options } = redisStore(() => null);

    await expect(new RedisLowStockAlertStore(options).read(tenant)).resolves.toEqual({ state: {} });
  });

  it("parses the claim outcome and attempt count", async () => {
    const { options } = redisStore(() => ["claimed", 3]);

    await expect(
      new RedisAlertOutboxStore(options).claim(tenant, "k", NOW, 1_000),
    ).resolves.toEqual({ outcome: "claimed", attempts: 3 });
  });

  it("treats an unrecognised claim reply as a backend failure", async () => {
    const { options } = redisStore(() => ["maybe", 1]);

    await expect(
      new RedisAlertOutboxStore(options).claim(tenant, "k", NOW, 1_000),
    ).rejects.toMatchObject({ code: "backend" });
  });

  it("refuses an insecure endpoint", () => {
    expect(() => new RedisLowStockAlertStore({ url: "http://redis.example.com", token: "t" })).toThrow(
      AlertStoreError,
    );
  });
});

describe("alert store factories", () => {
  it("never fall back to memory outside development and test", () => {
    for (const create of [createLowStockAlertStore, createAlertOutboxStore]) {
      expect(() =>
        create({ env: { NODE_ENV: "production", IKAS_ALERT_STORE_DRIVER: "memory" } }),
      ).toThrow(AlertStoreError);
      expect(() => create({ env: { NODE_ENV: "production" } })).toThrow(AlertStoreError);
    }
  });

  it("build redis stores from the production credential pair", () => {
    const env = {
      NODE_ENV: "production",
      UPSTASH_REDIS_REST_URL: "https://redis.example.com",
      UPSTASH_REDIS_REST_TOKEN: "token",
    };

    expect(createLowStockAlertStore({ env })).toBeInstanceOf(RedisLowStockAlertStore);
    expect(createAlertOutboxStore({ env })).toBeInstanceOf(RedisAlertOutboxStore);
  });
});
