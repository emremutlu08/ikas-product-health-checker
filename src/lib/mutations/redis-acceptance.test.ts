import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RedisAlertOutboxStore, RedisLowStockAlertStore } from "@/lib/alerts/alert-store";
import { RedisRestTenantDeletionStore } from "@/lib/lifecycle/tenant-deletion-store";
import { computePlanHash, RedisBulkBatchStore, type BulkBatchRecord } from "./bulk-batch-store";
import { buildSkuPayload } from "./mutation-fixtures";
import { RedisRestMutationOperationStore } from "./mutation-operation-store";
import { startUpstashRestShim, type UpstashShim } from "../../../test-support/upstash-rest-shim";

/**
 * Acceptance against a real Redis.
 *
 * Everything else in the suite exercises these stores against a stubbed transport, which proves
 * the request shapes but says nothing about whether the Lua is correct or whether the atomic
 * decisions actually hold under concurrency. This file runs the shipped scripts on a real server:
 * one claim wins a race, a replay never wins a second, an expiry is enforced by the script rather
 * than by the caller, and a tenant deletion barrier stops a write that is already in flight.
 *
 * It is opt-in because it needs a disposable Redis:
 *
 *   docker run --rm -d --name ikas-acceptance-redis -p 6399:6379 redis:7-alpine
 *   IKAS_REDIS_ACCEPTANCE=1 ./node_modules/.bin/vitest run src/lib/mutations/redis-acceptance.test.ts
 */

const enabled = process.env.IKAS_REDIS_ACCEPTANCE === "1";

const tenant = { authorizedAppId: "acceptance-app", merchantId: "acceptance-merchant" } as const;
const otherTenant = { authorizedAppId: "acceptance-app-2", merchantId: "acceptance-merchant-2" } as const;
const NOW = 1_753_000_100_000;

describe.skipIf(!enabled)("Redis acceptance", () => {
  let shim: UpstashShim;
  let operations: RedisRestMutationOperationStore;
  let batches: RedisBulkBatchStore;
  let outbox: RedisAlertOutboxStore;
  let alerts: RedisLowStockAlertStore;
  let deletion: RedisRestTenantDeletionStore;

  beforeAll(async () => {
    shim = await startUpstashRestShim();
    const options = { url: shim.url, token: shim.token, fetchImpl: shim.fetchImpl };
    operations = new RedisRestMutationOperationStore(options);
    batches = new RedisBulkBatchStore(options);
    outbox = new RedisAlertOutboxStore(options);
    alerts = new RedisLowStockAlertStore(options);
    deletion = new RedisRestTenantDeletionStore(options);
  });

  afterAll(async () => {
    await shim?.close();
  });

  beforeEach(async () => {
    await shim.flush();
  });

  describe("mutation operation lifecycle", () => {
    it("runs prepare, claim, settle and read back through the real scripts", async () => {
      const payload = buildSkuPayload();

      expect(await operations.prepare(tenant, payload)).toBe("prepared");
      expect(await operations.prepare(tenant, payload)).toBe("already_exists");

      const claim = await operations.claim(tenant, payload.operationId, NOW + 1_000);
      expect(claim).toEqual({ outcome: "claimed", payload });

      expect(
        await operations.settle(tenant, payload.operationId, {
          status: "succeeded",
          completedAt: NOW + 2_000,
          verifiedValue: "NEW-SKU",
        }),
      ).toBe("settled");

      expect(await operations.get(tenant, payload.operationId)).toMatchObject({
        status: "succeeded",
        settlement: { status: "succeeded", verifiedValue: "NEW-SKU" },
      });
    });

    it("admits exactly one winner when many requests race for the same claim", async () => {
      const payload = buildSkuPayload();
      await operations.prepare(tenant, payload);

      const results = await Promise.all(
        Array.from({ length: 25 }, () => operations.claim(tenant, payload.operationId, NOW + 1_000)),
      );

      expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
      expect(results.filter((result) => result.outcome === "replay")).toHaveLength(24);
    });

    it("lets the script, not the caller, decide that a confirmation has expired", async () => {
      const payload = buildSkuPayload();
      await operations.prepare(tenant, payload);

      expect(await operations.claim(tenant, payload.operationId, payload.expiresAt)).toEqual({
        outcome: "expired",
      });
      // An expired confirmation is still not claimable a moment earlier-looking clock later.
      expect(await operations.claim(tenant, payload.operationId, payload.expiresAt + 1)).toEqual({
        outcome: "expired",
      });
    });

    it("refuses to settle anything that is not currently executing", async () => {
      const payload = buildSkuPayload();
      await operations.prepare(tenant, payload);
      const settlement = {
        status: "rejected" as const,
        completedAt: NOW + 2_000,
        reason: "stale_value" as const,
      };

      expect(await operations.settle(tenant, payload.operationId, settlement)).toBe("not_executing");
      await operations.claim(tenant, payload.operationId, NOW + 1_000);
      expect(await operations.settle(tenant, payload.operationId, settlement)).toBe("settled");
      expect(await operations.settle(tenant, payload.operationId, settlement)).toBe("not_executing");
    });

    it("keeps one tenant's operation completely invisible to another", async () => {
      const payload = buildSkuPayload();
      await operations.prepare(tenant, payload);

      expect(await operations.get(otherTenant, payload.operationId)).toBeUndefined();
      expect(await operations.claim(otherTenant, payload.operationId, NOW + 1_000)).toEqual({
        outcome: "missing",
      });
      expect(await operations.listRecent(otherTenant, 10)).toEqual([]);
    });

    it("indexes recent operations and deletes every one of them for a tenant", async () => {
      for (const [index, operationId] of ["op-a", "op-b", "op-c"].entries()) {
        await operations.prepare(
          tenant,
          buildSkuPayload({ operationId, createdAt: NOW + index, expiresAt: NOW + index + 60_000 }),
        );
      }

      expect(await operations.listRecent(tenant, 10)).toEqual(["op-c", "op-b", "op-a"]);
      expect(await operations.deleteTenant(tenant)).toBe("deleted");
      expect(await operations.get(tenant, "op-a")).toBeUndefined();
      expect(await operations.listRecent(tenant, 10)).toEqual([]);
      expect(await operations.deleteTenant(tenant)).toBe("absent");
    });
  });

  describe("tenant deletion barrier", () => {
    it("stops a prepare, a claim and a settle that were already under way", async () => {
      const payload = buildSkuPayload();
      await operations.prepare(tenant, payload);
      await operations.claim(tenant, payload.operationId, NOW + 1_000);

      expect(await deletion.markDeleted(tenant)).toBe("marked");

      await expect(operations.prepare(tenant, buildSkuPayload({ operationId: "op-later" }))).rejects.toMatchObject(
        { code: "tenant_deleted" },
      );
      await expect(operations.claim(tenant, payload.operationId, NOW + 2_000)).rejects.toMatchObject({
        code: "tenant_deleted",
      });
      await expect(
        operations.settle(tenant, payload.operationId, {
          status: "succeeded",
          completedAt: NOW + 3_000,
          verifiedValue: "NEW-SKU",
        }),
      ).rejects.toMatchObject({ code: "tenant_deleted" });
    });

    it("is permanent: re-marking is idempotent and never reopens the tenant", async () => {
      expect(await deletion.markDeleted(tenant)).toBe("marked");
      expect(await deletion.markDeleted(tenant)).toBe("already_marked");
      await expect(operations.prepare(tenant, buildSkuPayload())).rejects.toMatchObject({
        code: "tenant_deleted",
      });
    });

    it("blocks alert state writes and alert delivery for a deleted tenant", async () => {
      await deletion.markDeleted(tenant);

      await expect(alerts.write(tenant, { state: {}, lastScanId: "scan-1" })).rejects.toMatchObject({
        code: "tenant_deleted",
      });
      await expect(outbox.claim(tenant, "alert/scan-1/low-stock", NOW, 60_000)).rejects.toMatchObject({
        code: "tenant_deleted",
      });
    });

    it("leaves a different tenant entirely unaffected", async () => {
      await deletion.markDeleted(tenant);

      expect(await operations.prepare(otherTenant, buildSkuPayload())).toBe("prepared");
    });
  });

  describe("bulk batch confirmation", () => {
    function batchRecord(): BulkBatchRecord {
      const items = [
        { index: 0, productId: "product-1", variantId: "variant-1", state: "ready" as const, operationId: "op-1" },
        { index: 1, productId: "product-2", variantId: "variant-2", state: "invalid" as const, reason: "no_change" },
      ];
      return {
        version: 1,
        batchId: "batch-1",
        status: "planned",
        planHash: computePlanHash("batch-1", items),
        createdAt: NOW,
        expiresAt: NOW + 15 * 60 * 1000,
        items,
      };
    }

    it("confirms exactly once even when many requests race", async () => {
      const record = batchRecord();
      await batches.create(tenant, record);

      const results = await Promise.all(
        Array.from({ length: 15 }, () =>
          batches.confirm(tenant, record.batchId, record.planHash, NOW + 1_000),
        ),
      );

      expect(results.filter((outcome) => outcome === "confirmed")).toHaveLength(1);
      expect(results.filter((outcome) => outcome === "replay")).toHaveLength(14);
    });

    it("refuses a confirmation that does not match the stored plan", async () => {
      const record = batchRecord();
      await batches.create(tenant, record);

      expect(await batches.confirm(tenant, record.batchId, "x".repeat(43), NOW + 1_000)).toBe(
        "plan_mismatch",
      );
      expect(await batches.get(tenant, record.batchId)).toMatchObject({ status: "planned" });
    });

    it("refuses a confirmation after the window closes", async () => {
      const record = batchRecord();
      await batches.create(tenant, record);

      expect(await batches.confirm(tenant, record.batchId, record.planHash, record.expiresAt)).toBe(
        "expired",
      );
    });

    it("stops a cancelled batch from being confirmed at all", async () => {
      const record = batchRecord();
      await batches.create(tenant, record);
      expect(await batches.setStatus(tenant, record.batchId, "cancelled")).toBe(true);

      expect(await batches.confirm(tenant, record.batchId, record.planHash, NOW + 1_000)).toBe(
        "cancelled",
      );
      expect(await batches.setStatus(tenant, record.batchId, "running")).toBe(false);
    });

    it("never resolves another tenant's batch", async () => {
      const record = batchRecord();
      await batches.create(tenant, record);

      expect(await batches.get(otherTenant, record.batchId)).toBeUndefined();
      expect(await batches.confirm(otherTenant, record.batchId, record.planHash, NOW + 1_000)).toBe(
        "missing",
      );
    });
  });

  describe("alert delivery outbox", () => {
    it("admits exactly one sender when many workers race for the same notification", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => outbox.claim(tenant, "alert/scan-1/low-stock", NOW, 60_000)),
      );

      expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
      expect(results.filter((result) => result.outcome === "in_flight")).toHaveLength(19);
    });

    it("makes a delivered notification terminal", async () => {
      await outbox.claim(tenant, "k", NOW, 60_000);
      await outbox.markSent(tenant, "k");

      expect(await outbox.claim(tenant, "k", NOW + 10_000_000, 60_000)).toMatchObject({
        outcome: "already_sent",
      });
    });

    it("holds a failed delivery in backoff and then allows a bounded retry", async () => {
      await outbox.claim(tenant, "k", NOW, 1_000);
      await outbox.markFailed(tenant, "k", NOW + 900_000);

      expect(await outbox.claim(tenant, "k", NOW + 1_000, 1_000)).toMatchObject({
        outcome: "backoff",
      });
      expect(await outbox.claim(tenant, "k", NOW + 900_000, 1_000)).toEqual({
        outcome: "claimed",
        attempts: 2,
      });
    });

    it("stops retrying once the attempt budget is spent", async () => {
      let now = NOW;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await outbox.claim(tenant, "k", now, 1_000);
        await outbox.markFailed(tenant, "k", now);
        now += 10_000;
      }

      expect(await outbox.claim(tenant, "k", now, 1_000)).toMatchObject({ outcome: "exhausted" });
    });
  });

  describe("alert state", () => {
    it("round-trips a record and removes it on tenant cleanup", async () => {
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

      await alerts.write(tenant, record);
      expect(await alerts.read(tenant)).toEqual(record);
      expect(await alerts.read(otherTenant)).toEqual({ state: {} });

      expect(await alerts.deleteTenant(tenant)).toBe("deleted");
      expect(await alerts.read(tenant)).toEqual({ state: {} });
    });
  });
});
