import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createMonitoringScheduleStore,
  MemoryMonitoringScheduleStore,
  RedisRestMonitoringScheduleStore,
  type MonitoringScheduleTenant,
} from "./schedule-store";

const TENANT: MonitoringScheduleTenant = {
  authorizedAppId: "authorized-app-1",
  merchantId: "merchant-1",
};
const OTHER_TENANT: MonitoringScheduleTenant = {
  authorizedAppId: "authorized-app-2",
  merchantId: "merchant-2",
};

function digest(tenant: MonitoringScheduleTenant) {
  return createHash("sha256")
    .update([tenant.authorizedAppId, tenant.merchantId].join("\u0000"), "utf8")
    .digest("base64url");
}

describe("monitoring schedule store", () => {
  it("blocks overlap with a short lease and starts the 23-hour interval only on completion", async () => {
    const store = new MemoryMonitoringScheduleStore();
    const first = Date.parse("2026-07-22T10:00:00.000Z");
    const claim = await store.claimIfDue(TENANT, "owner-1", first, 23 * 60 * 60 * 1000, 10 * 60 * 1000);

    expect(claim).toBeDefined();
    expect(claim?.deliveryId).toBe("owner-1");
    await expect(
      store.claimIfDue(TENANT, "owner-2", first + 1_000, 23 * 60 * 60 * 1000, 10 * 60 * 1000),
    ).resolves.toBeUndefined();
    await expect(store.release(claim!)).resolves.toBe(true);

    const retry = await store.claimIfDue(
      TENANT,
      "owner-3",
      first + 2_000,
      23 * 60 * 60 * 1000,
      10 * 60 * 1000,
    );
    expect(retry).toBeDefined();
    expect(retry?.deliveryId).toBe(claim?.deliveryId);
    await expect(store.complete(retry!, first + 3_000)).resolves.toBe(true);

    await expect(
      store.claimIfDue(TENANT, "owner-4", first + 22 * 60 * 60 * 1000, 23 * 60 * 60 * 1000, 10 * 60 * 1000),
    ).resolves.toBeUndefined();
    await expect(
      store.claimIfDue(TENANT, "owner-5", first + 23 * 60 * 60 * 1000 + 3_000, 23 * 60 * 60 * 1000, 10 * 60 * 1000),
    ).resolves.toBeDefined();
  });

  it("does not let a stale owner complete or release another run", async () => {
    const store = new MemoryMonitoringScheduleStore();
    const now = Date.parse("2026-07-22T10:00:00.000Z");
    const first = await store.claimIfDue(TENANT, "owner-1", now, 1_000, 100);
    expect(first).toBeDefined();
    const second = await store.claimIfDue(TENANT, "owner-2", now + 101, 1_000, 100);
    expect(second).toBeDefined();

    await expect(store.complete(first!, now + 102)).resolves.toBe(false);
    await expect(store.release(first!)).resolves.toBe(false);
    await expect(store.complete(second!, now + 103)).resolves.toBe(true);
  });

  it("uses hashed Redis keys and atomic owner-checked lifecycle commands", async () => {
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const command = JSON.parse(String(init?.body)) as Array<string | number>;
      expect(command[0]).toBe("EVAL");
      expect(JSON.stringify(command)).toContain(`ikas:monitoring-schedule:v2:${digest(TENANT)}`);
      expect(JSON.stringify(command)).not.toContain(TENANT.authorizedAppId);
      expect(JSON.stringify(command)).not.toContain(TENANT.merchantId);
      call += 1;
      return Response.json({ result: call === 1 ? "delivery-1" : 1 });
    });
    const store = new RedisRestMonitoringScheduleStore({
      url: "https://redis.example.com",
      token: "redis-token",
      fetchImpl,
    });

    const claim = await store.claimIfDue(TENANT, "owner-1", 1_700_000_000_000, 82_800_000, 600_000);
    expect(claim).toMatchObject({ ownerId: "owner-1", deliveryId: "delivery-1" });
    await expect(store.complete(claim!, 1_700_000_001_000)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("atomically rejects stale claims and completions after tombstoning", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ result: "tenant_deleted" }));
    const store = new RedisRestMonitoringScheduleStore({
      url: "https://redis.example.com",
      token: "redis-token",
      fetchImpl,
    });

    await expect(
      store.claimIfDue(TENANT, "owner-1", 1_700_000_000_000, 82_800_000, 600_000),
    ).rejects.toMatchObject({ code: "tenant_deleted" });
    await expect(
      store.complete(
        { tenant: TENANT, ownerId: "owner-1", deliveryId: "delivery-1" },
        1_700_000_001_000,
      ),
    ).rejects.toMatchObject({ code: "tenant_deleted" });

    const commands = fetchImpl.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as string[],
    );
    expect(commands[0]?.[2]).toBe(4);
    expect(commands[0]?.[6]).toBe(commands[1]?.[6]);
    expect(commands[0]?.[6]).toContain("ikas:tenant-deleted:v1:");
    expect(commands[0]?.[6]).not.toContain(TENANT.authorizedAppId);
    expect(commands[0]?.[6]).not.toContain(TENANT.merchantId);
  });

  it("atomically deletes the exact success, lease, and delivery keys and validates the result", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: 3 }))
      .mockResolvedValueOnce(Response.json({ result: 0 }))
      .mockResolvedValueOnce(Response.json({ result: "3" }));
    const store = new RedisRestMonitoringScheduleStore({
      url: "https://redis.example.com",
      token: "redis-token",
      fetchImpl,
    });

    await expect(store.deleteTenant(TENANT)).resolves.toBe("deleted");
    const command = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const base = `ikas:monitoring-schedule:v2:${digest(TENANT)}`;
    expect(command.slice(0, 3)).toEqual(["EVAL", expect.any(String), 3]);
    expect(command.slice(3)).toEqual([
      `${base}:success`,
      `${base}:lease`,
      `${base}:delivery`,
    ]);
    expect(String(command[1])).not.toContain("SCAN");
    await expect(store.deleteTenant(TENANT)).resolves.toBe("absent");
    await expect(store.deleteTenant(TENANT)).rejects.toMatchObject({ code: "backend" });
  });

  it("invalidates an active memory claim, clears cadence, and isolates other tenants", async () => {
    const store = new MemoryMonitoringScheduleStore();
    const now = Date.parse("2026-07-22T10:00:00.000Z");
    const claim = await store.claimIfDue(TENANT, "owner-1", now, 1_000, 30_000);
    const otherClaim = await store.claimIfDue(OTHER_TENANT, "owner-2", now, 1_000, 30_000);
    await store.complete(otherClaim!, now + 1);

    await expect(store.deleteTenant(TENANT)).resolves.toBe("deleted");
    await expect(store.complete(claim!, now + 2)).resolves.toBe(false);
    await expect(store.deleteTenant(TENANT)).resolves.toBe("absent");
    await expect(
      store.claimIfDue(TENANT, "owner-3", now + 3, 1_000, 30_000),
    ).resolves.toBeDefined();
    await expect(
      store.claimIfDue(OTHER_TENANT, "owner-4", now + 3, 1_000, 30_000),
    ).resolves.toBeUndefined();
  });

  it("fails closed for invalid configuration and production memory usage", () => {
    expect(() =>
      createMonitoringScheduleStore({ env: { NODE_ENV: "production", IKAS_SCHEDULE_STORE_DRIVER: "memory" } }),
    ).toThrow();
    expect(() =>
      createMonitoringScheduleStore({ env: { NODE_ENV: "production", IKAS_SCHEDULE_STORE_DRIVER: "redis" } }),
    ).toThrow();
  });
});
