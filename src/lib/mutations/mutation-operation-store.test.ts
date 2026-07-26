import { describe, expect, it } from "vitest";
import {
  MemoryMutationOperationStore,
  RedisRestMutationOperationStore,
  type PreparedSkuOperation,
} from "./mutation-operation-store";

const tenant = { authorizedAppId: "app-1", merchantId: "merchant-1" };

function prepared(): PreparedSkuOperation {
  return {
    version: 1,
    operationId: "op-1",
    kind: "sku_change",
    status: "prepared",
    productId: "product-1",
    variantId: "variant-1",
    expectedProductUpdatedAt: "2026-07-26T07:55:00.000Z",
    expectedPreviousSku: null,
    proposedSku: "SAFE-SKU",
    createdAt: 1_785_000_000_000,
    expiresAt: 1_785_000_600_000,
  };
}

describe("MemoryMutationOperationStore", () => {
  it("creates one tenant-bound prepared operation and refuses an operation-id replay", async () => {
    const store = new MemoryMutationOperationStore();

    await expect(store.prepare(tenant, prepared())).resolves.toBe("prepared");
    await expect(store.prepare(tenant, prepared())).resolves.toBe("already_exists");
    await expect(store.get(tenant, "op-1")).resolves.toEqual(prepared());
    await expect(
      store.get({ authorizedAppId: "app-1", merchantId: "other-merchant" }, "op-1"),
    ).resolves.toBeUndefined();
  });

  it("claims a prepared confirmation exactly once and rejects a replay", async () => {
    const store = new MemoryMutationOperationStore();
    await store.prepare(tenant, prepared());

    await expect(store.claim(tenant, "op-1", 1_785_000_001_000)).resolves.toEqual({
      outcome: "claimed",
      operation: {
        ...prepared(),
        status: "executing",
        claimedAt: 1_785_000_001_000,
      },
    });
    await expect(store.claim(tenant, "op-1", 1_785_000_002_000)).resolves.toEqual({
      outcome: "replay",
    });
  });

  it("settles an executing operation once with a minimal verified audit result", async () => {
    const store = new MemoryMutationOperationStore();
    await store.prepare(tenant, prepared());
    await store.claim(tenant, "op-1", 1_785_000_001_000);

    await expect(
      store.settle(tenant, "op-1", {
        status: "succeeded",
        completedAt: 1_785_000_002_000,
        verifiedSku: "SAFE-SKU",
      }),
    ).resolves.toBe(true);
    await expect(store.get(tenant, "op-1")).resolves.toMatchObject({
      status: "succeeded",
      completedAt: 1_785_000_002_000,
      verifiedSku: "SAFE-SKU",
    });
    await expect(
      store.settle(tenant, "op-1", {
        status: "succeeded",
        completedAt: 1_785_000_003_000,
        verifiedSku: "OTHER-SKU",
      }),
    ).resolves.toBe(false);
  });
});

describe("RedisRestMutationOperationStore", () => {
  it("prepares with one deletion-fenced NX+PX Lua command and opaque keys", async () => {
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body));
      expect(command.slice(0, 3)).toEqual(["EVAL", expect.any(String), 2]);
      expect(command[1]).toContain("EXISTS");
      expect(command[1]).toContain("NX");
      expect(command[1]).toContain("PX");
      expect(command[1]).not.toContain("then;");
      expect(command[3]).not.toContain("app-1");
      expect(command[3]).not.toContain("merchant-1");
      expect(command[4]).not.toContain("app-1");
      expect(command[4]).not.toContain("merchant-1");
      expect(Number(command.at(-1))).toBe(600_000);
      return Response.json({ result: 1 });
    };
    const store = new RedisRestMutationOperationStore({
      url: "https://redis.example.test",
      token: "redis-token",
      fetchImpl: fetchMock,
    });

    await expect(store.prepare(tenant, prepared())).resolves.toBe("prepared");
  });

  it("claims with one deletion-fenced state transition and returns the executing audit", async () => {
    const executing = {
      ...prepared(),
      status: "executing" as const,
      claimedAt: 1_785_000_001_000,
    };
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body));
      expect(command.slice(0, 3)).toEqual(["EVAL", expect.any(String), 2]);
      expect(command[1]).toContain("cjson.decode");
      expect(command[1]).toContain("prepared");
      expect(command[1]).toContain("PX");
      expect(command[1]).not.toContain("then;");
      expect(command[3]).not.toContain("app-1");
      expect(command[4]).not.toContain("app-1");
      return Response.json({ result: JSON.stringify(executing) });
    };
    const store = new RedisRestMutationOperationStore({
      url: "https://redis.example.test",
      token: "redis-token",
      fetchImpl: fetchMock,
    });

    await expect(store.claim(tenant, "op-1", 1_785_000_001_000)).resolves.toEqual({
      outcome: "claimed",
      operation: executing,
    });
  });

  it("settles only an executing Redis operation behind the deletion and tenant fences", async () => {
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body));
      expect(command.slice(0, 3)).toEqual(["EVAL", expect.any(String), 2]);
      expect(command[1]).toContain("executing");
      expect(command[1]).toContain("tenantMarker");
      expect(command[1]).not.toContain("then;");
      return Response.json({ result: 1 });
    };
    const store = new RedisRestMutationOperationStore({
      url: "https://redis.example.test",
      token: "redis-token",
      fetchImpl: fetchMock,
    });

    await expect(
      store.settle(tenant, "op-1", {
        status: "succeeded",
        completedAt: 1_785_000_002_000,
        verifiedSku: "SAFE-SKU",
      }),
    ).resolves.toBe(true);
  });
});
