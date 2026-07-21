import { describe, expect, it, vi } from "vitest";
import { PRODUCT_SCAN_MAX_PRODUCTS } from "@/lib/ikas/product-adapter";
import type { HealthIssue, HealthReport } from "@/lib/ikas/types";
import {
  createSnapshotStore,
  isSnapshotStale,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_PRODUCT_ROWS,
  MemorySnapshotStore,
  SNAPSHOT_STALE_AFTER_MS,
  RedisRestSnapshotStore,
  SnapshotStoreError,
  toSafeSnapshot,
  type ScanSnapshot,
} from "./snapshot-store";

const credentials = {
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "redis-token",
};

const tenant = { authorizedAppId: "app-1", merchantId: "merchant-1" };
const otherTenant = { authorizedAppId: "app-2", merchantId: "merchant-2" };

/**
 * A snapshot fixture has to be a report the production rule engine could actually emit:
 * every aggregate below is the true count of the `issues` and `productRows` beneath it.
 * The store rejects any record whose aggregates disagree with its own rows, so an
 * internally contradictory fixture would only ever prove that rejection works.
 */
const report: HealthReport = {
  generatedAt: "2026-07-20T08:00:00.000Z",
  score: 82,
  productCount: 3,
  variantCount: 5,
  issueCount: 2,
  affectedProductCount: 1,
  scanStatus: "success",
  issueCountsByCode: {
    missing_sku: 1,
    missing_barcode: 0,
    duplicate_sku: 0,
    duplicate_barcode: 0,
    missing_image: 0,
    missing_description: 0,
    missing_category: 0,
    missing_brand: 0,
    missing_vendor: 0,
    zero_stock_blocked: 1,
    missing_price: 0,
    duplicate_title: 0,
    weird_description: 0,
  },
  criticalCount: 2,
  warningCount: 0,
  infoCount: 0,
  outOfStockBlockedCount: 1,
  // Production emits one summary per canonical rule, including the rules no issue triggered,
  // so the dashboard's filter row is the same width on every scan.
  ruleSummaries: [
    { code: "incorrect_price", label: "Hatalı Fiyat", count: 0 },
    { code: "out_of_stock", label: "Stokta Yok", count: 1 },
    { code: "missing_images", label: "Görsel Eksik", count: 0 },
    { code: "missing_sku", label: "SKU Eksik", count: 1 },
    { code: "same_sku", label: "Aynı SKU", count: 0 },
    { code: "duplicate_title", label: "Tekrarlanan Başlık", count: 0 },
    { code: "weird_description", label: "Sorunlu Açıklama", count: 0 },
  ],
  productRows: [
    {
      productId: "product-1",
      productName: "Eksik SKU Ürünü",
      imageLabel: "ES",
      updatedAt: "2026-07-19T08:00:00.000Z",
      mistakes: ["SKU Eksik", "Stokta Yok"],
      actionLabel: "İncele",
    },
  ],
  issues: [
    {
      code: "missing_sku",
      severity: "critical",
      productId: "product-1",
      productName: "Eksik SKU Ürünü",
      message: "SKU yok.",
    },
    {
      code: "zero_stock_blocked",
      severity: "critical",
      productId: "product-1",
      productName: "Eksik SKU Ürünü",
      message: "Varyant stokta yok ve stok dışı satış kapalı.",
      value: 0,
    },
  ],
};

function snapshotFor(overrides: Partial<ScanSnapshot> = {}): ScanSnapshot {
  return {
    version: 1,
    scanId: "scan-1",
    authorizedAppId: tenant.authorizedAppId,
    merchantId: tenant.merchantId,
    generatedAt: "2026-07-20T08:00:00.000Z",
    report,
    ...overrides,
  };
}

function redisResponse(result: unknown) {
  return new Response(JSON.stringify({ result }), { status: 200 });
}

function redisStore(fetchImpl: typeof fetch) {
  return new RedisRestSnapshotStore({
    url: credentials.UPSTASH_REDIS_REST_URL,
    token: credentials.UPSTASH_REDIS_REST_TOKEN,
    fetchImpl,
  });
}

function commandOf(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body)) as Array<string | number>;
}

function reportWith(changes: Partial<HealthReport>): ScanSnapshot {
  return snapshotFor({ report: { ...report, ...changes } });
}

/**
 * Builds a consistent report whose issues carry maximum-length text, so the fixture grows
 * the way a hostile or pathological catalog would: many rows, each at the field ceiling.
 * `filler` lets a test push UTF-8 bytes past the ceiling while the UTF-16 string stays
 * under it.
 */
function bulkyReport(issueCount: number, filler = "x"): HealthReport {
  const text = (maxLength: number) => filler.repeat(Math.floor(maxLength / filler.length));
  const issues: HealthIssue[] = Array.from({ length: issueCount }, (_, index) => ({
    code: "missing_sku",
    severity: "critical",
    productId: `product-${index}`,
    productName: text(1024),
    variantId: `variant-${index}`,
    variantLabel: text(1024),
    message: text(2048),
    value: text(1024),
    productUpdatedAt: "2026-07-19T08:00:00.000Z",
  }));

  return {
    ...report,
    productCount: issueCount,
    issueCount,
    affectedProductCount: issueCount,
    issueCountsByCode: { ...report.issueCountsByCode, missing_sku: issueCount, zero_stock_blocked: 0 },
    criticalCount: issueCount,
    outOfStockBlockedCount: 0,
    ruleSummaries: report.ruleSummaries.map((summary) =>
      summary.code === "missing_sku"
        ? { ...summary, count: issueCount }
        : { ...summary, count: 0 },
    ),
    productRows: issues.map((issue) => ({
      productId: issue.productId,
      productName: "row",
      imageLabel: "RO",
      mistakes: ["SKU Eksik"],
      actionLabel: "İncele",
    })),
    issues,
  };
}

function serializedBytes(snapshot: ScanSnapshot) {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

/**
 * A record that fails the snapshot contract must be refused on the way in and on the way
 * out: a write-only check would still render whatever a corrupted key already holds.
 */
async function expectRejectedOnPutAndGet(snapshot: ScanSnapshot) {
  await expect(new MemorySnapshotStore().putLatest(snapshot)).rejects.toMatchObject({
    name: "SnapshotStoreError",
    operation: "put",
  });

  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => redisResponse(JSON.stringify(snapshot)));
  await expect(redisStore(fetchMock).getLatest(tenant)).rejects.toMatchObject({
    code: "corrupt_record",
    operation: "get",
  });
}

describe("scan snapshot schema", () => {
  it("keeps a minimal tenant-bound record and never persists a token or raw catalog payload", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse("OK"));

    await redisStore(fetchMock).putLatest(snapshotFor());

    const command = commandOf(fetchMock);
    expect(command[0]).toBe("SET");
    const persisted = JSON.parse(String(command[2])) as ScanSnapshot;
    expect(persisted).toEqual(snapshotFor());
    expect(String(command[2])).not.toContain("accessToken");
    expect(String(command[2])).not.toContain("refreshToken");
    expect(String(command[2])).not.toContain("variants");
    // The raw tenant identifiers must not leak into the Redis key space.
    expect(command[1]).not.toContain("app-1");
    expect(command[1]).not.toContain("merchant-1");
  });

  it("drops fields that are not part of the snapshot contract", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse("OK"));
    const hostile = { ...snapshotFor(), accessToken: "secret-token", rawProducts: [{ id: "p" }] };

    await redisStore(fetchMock).putLatest(hostile as ScanSnapshot);

    expect(String(commandOf(fetchMock)[2])).not.toContain("secret-token");
    expect(String(commandOf(fetchMock)[2])).not.toContain("rawProducts");
  });

  it("exposes safe snapshot metadata without tenant identifiers", () => {
    const safe = toSafeSnapshot(snapshotFor());

    expect(safe.scanId).toBe("scan-1");
    expect(safe.generatedAt).toBe("2026-07-20T08:00:00.000Z");
    expect(JSON.stringify(safe)).not.toContain("app-1");
    expect(JSON.stringify(safe)).not.toContain("merchant-1");
  });

  /**
   * The persisted record keeps its original `score` field so snapshots written under the old
   * formula stay readable, but that number is not the one the dashboard shows. Publishing both
   * would give a merchant two different health values for one scan, so the public projection
   * carries exactly one: the normalized assessment, derived here from the same model the
   * dashboard renders.
   */
  it("publishes the normalized health model rather than the persisted legacy score", () => {
    const safe = toSafeSnapshot(snapshotFor());

    // 2 critical issues x weight 7, over 3 products, against the 20-point ceiling.
    expect(safe.health.score).toBe(77);
    expect(safe.health.state).toBe("attention");
    expect(snapshotFor().report.score).toBe(82);
  });

  it("leaves no second merchant-visible score in the published report", () => {
    const safe = toSafeSnapshot(snapshotFor());

    expect(safe.report).not.toHaveProperty("score");
    expect(JSON.stringify(safe)).not.toContain('"score":82');
  });

  it("publishes no score for a catalog with nothing to score", () => {
    const empty = snapshotFor({
      report: {
        ...report,
        score: 100,
        productCount: 0,
        affectedProductCount: 0,
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
        issueCount: 0,
        outOfStockBlockedCount: 0,
        issueCountsByCode: { ...report.issueCountsByCode, missing_sku: 0, zero_stock_blocked: 0 },
        ruleSummaries: report.ruleSummaries.map((summary) => ({ ...summary, count: 0 })),
        productRows: [],
        issues: [],
      },
    });

    const safe = toSafeSnapshot(empty);

    expect(safe.health.score).toBeNull();
    expect(safe.health.state).toBe("unknown");
    expect(safe.report).not.toHaveProperty("score");
  });

  it("keeps persisting the legacy score so snapshots written under the old model stay readable", async () => {
    const store = new MemorySnapshotStore();
    await store.putLatest(snapshotFor());

    const stored = await store.getLatest(tenant);

    expect(stored?.report.score).toBe(82);
  });
});

describe("tenant partitioning", () => {
  it("keys the latest snapshot by both installation and merchant", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse("OK"));
    const store = redisStore(fetchMock);

    await store.putLatest(snapshotFor());
    await store.putLatest(snapshotFor({ ...otherTenant, scanId: "scan-2" }));

    expect(commandOf(fetchMock, 0)[1]).not.toBe(commandOf(fetchMock, 1)[1]);
  });

  it("never returns another tenant's snapshot from the in-memory store", async () => {
    const store = new MemorySnapshotStore();
    await store.putLatest(snapshotFor());

    await expect(store.getLatest(otherTenant)).resolves.toBeUndefined();
    await expect(store.getLatest(tenant)).resolves.toEqual(snapshotFor());
  });

  it("refuses to persist a snapshot whose body contradicts its own tenant fields", async () => {
    const store = new MemorySnapshotStore();

    await expect(
      store.putLatest(snapshotFor({ authorizedAppId: "" })),
    ).rejects.toBeInstanceOf(SnapshotStoreError);
    await expect(store.putLatest(snapshotFor({ merchantId: "" }))).rejects.toBeInstanceOf(
      SnapshotStoreError,
    );
  });

  it("fails closed when a stored record belongs to a different tenant", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => redisResponse(JSON.stringify(snapshotFor(otherTenant))));

    await expect(redisStore(fetchMock).getLatest(tenant)).rejects.toMatchObject({
      code: "corrupt_record",
    });
  });
});

describe("fail-closed validation of persisted data", () => {
  it.each([
    { name: "invalid JSON", raw: "{not-json" },
    { name: "a non-object record", raw: JSON.stringify("snapshot") },
    { name: "an unknown schema version", raw: JSON.stringify({ ...snapshotFor(), version: 2 }) },
    { name: "a missing report", raw: JSON.stringify({ ...snapshotFor(), report: undefined }) },
    { name: "a non-ISO timestamp", raw: JSON.stringify(snapshotFor({ generatedAt: "yesterday" })) },
    {
      name: "a report with the wrong shape",
      raw: JSON.stringify(snapshotFor({ report: { ...report, score: "high" } as unknown as HealthReport })),
    },
    {
      name: "an unknown issue code",
      raw: JSON.stringify(
        snapshotFor({
          report: { ...report, issues: [{ ...report.issues[0], code: "made_up_rule" }] } as unknown as HealthReport,
        }),
      ),
    },
  ])("rejects $name instead of rendering it", async ({ raw }) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse(raw));

    await expect(redisStore(fetchMock).getLatest(tenant)).rejects.toMatchObject({
      code: "corrupt_record",
    });
  });

  it("returns undefined when no snapshot has been stored yet", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse(null));

    await expect(redisStore(fetchMock).getLatest(tenant)).resolves.toBeUndefined();
  });

  it("treats a backend outage as a failure rather than a missing snapshot", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 500 }));

    await expect(redisStore(fetchMock).getLatest(tenant)).rejects.toMatchObject({ code: "backend" });
  });
});

describe("bounded snapshot payload", () => {
  it("refuses an oversized snapshot before it reaches Redis", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse("OK"));
    const oversized = snapshotFor({ report: bulkyReport(200) });
    expect(serializedBytes(oversized)).toBeGreaterThan(MAX_SNAPSHOT_BYTES);

    await expect(redisStore(fetchMock).putLatest(oversized)).rejects.toMatchObject({
      code: "payload_too_large",
      operation: "put",
    });
    // Rejected in-process: no oversized body is ever handed to the transport.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("measures the ceiling in UTF-8 bytes rather than JavaScript string length", async () => {
    // Every filler char is one UTF-16 pair but four UTF-8 bytes, so a length-based check
    // would wave this through at roughly half the true wire size.
    const oversized = snapshotFor({ report: bulkyReport(100, "𝄞") });
    expect(JSON.stringify(oversized).length).toBeLessThan(MAX_SNAPSHOT_BYTES);
    expect(serializedBytes(oversized)).toBeGreaterThan(MAX_SNAPSHOT_BYTES);

    await expect(new MemorySnapshotStore().putLatest(oversized)).rejects.toMatchObject({
      code: "payload_too_large",
      operation: "put",
    });
  });

  it("keeps the previous successful snapshot when a new scan's snapshot is oversized", async () => {
    const store = new MemorySnapshotStore();
    await store.putLatest(snapshotFor());

    await expect(
      store.putLatest(snapshotFor({ scanId: "scan-2", report: bulkyReport(200) })),
    ).rejects.toBeInstanceOf(SnapshotStoreError);

    await expect(store.getLatest(tenant)).resolves.toEqual(snapshotFor());
  });

  it("refuses an oversized persisted record before parsing it", async () => {
    // Deliberately not valid JSON: a `payload_too_large` verdict proves the size gate runs
    // ahead of the parser rather than after it has already expanded the payload.
    const raw = "{".repeat(MAX_SNAPSHOT_BYTES + 1);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse(raw));

    await expect(redisStore(fetchMock).getLatest(tenant)).rejects.toMatchObject({
      code: "payload_too_large",
      operation: "get",
    });
  });

  it("bounds persisted product rows by the catalog scan budget", async () => {
    expect(MAX_SNAPSHOT_PRODUCT_ROWS).toBe(PRODUCT_SCAN_MAX_PRODUCTS);

    const tooManyRows = reportWith({
      productRows: Array.from({ length: MAX_SNAPSHOT_PRODUCT_ROWS + 1 }, (_, index) => ({
        ...report.productRows[0],
        productId: `product-${index}`,
      })),
    });

    await expect(new MemorySnapshotStore().putLatest(tooManyRows)).rejects.toBeInstanceOf(
      SnapshotStoreError,
    );
  });
});

describe("fail-closed persisted report invariants", () => {
  it.each([
    {
      name: "a report timestamp that is not canonical ISO",
      snapshot: reportWith({ generatedAt: "2026-07-20T08:00:00Z" }),
    },
    {
      name: "a report timestamp that disagrees with the snapshot timestamp",
      snapshot: reportWith({ generatedAt: "2026-07-19T08:00:00.000Z" }),
    },
    {
      name: "an issue timestamp that is not canonical ISO",
      snapshot: reportWith({
        issues: [{ ...report.issues[0], productUpdatedAt: "2026-07-19" }, report.issues[1]],
      }),
    },
    {
      name: "a product row timestamp that is not canonical ISO",
      snapshot: reportWith({
        productRows: [{ ...report.productRows[0], updatedAt: "2026-07-19T08:00:00+03:00" }],
      }),
    },
    { name: "a scan that never completed", snapshot: reportWith({ scanStatus: "queued" }) },
    { name: "an issue count that contradicts the rows", snapshot: reportWith({ issueCount: 3 }) },
    {
      name: "severity counts that contradict the issue severities",
      snapshot: reportWith({ criticalCount: 1, warningCount: 1 }),
    },
    {
      name: "severity counts that do not sum to the issue count",
      snapshot: reportWith({ warningCount: 1 }),
    },
    {
      name: "a per-code count that contradicts the issues",
      snapshot: reportWith({
        issueCountsByCode: { ...report.issueCountsByCode, missing_sku: 5 },
      }),
    },
    {
      name: "a blocked-stock count that contradicts the issues",
      snapshot: reportWith({ outOfStockBlockedCount: 0 }),
    },
    {
      name: "an affected product count that contradicts the issues",
      snapshot: reportWith({ affectedProductCount: 2 }),
    },
    {
      name: "a product count below the affected product count",
      snapshot: reportWith({ productCount: 0 }),
    },
    {
      name: "duplicate product rows for one product",
      snapshot: reportWith({ productRows: [report.productRows[0], report.productRows[0]] }),
    },
    {
      name: "a product row for a product with no matching issue",
      snapshot: reportWith({
        productRows: [report.productRows[0], { ...report.productRows[0], productId: "product-9" }],
      }),
    },
    {
      name: "a missing product row for an affected product",
      snapshot: reportWith({ productRows: [] }),
    },
    {
      // The dashboard filters the table by matching a summary label against these strings,
      // so a row carrying a rule its own issues never raised surfaces a clean product under
      // a problem filter — the aggregates above it all still add up.
      name: "a product row claiming a mistake no issue supports",
      snapshot: reportWith({
        productRows: [
          { ...report.productRows[0], mistakes: ["SKU Eksik", "Stokta Yok", "Görsel Eksik"] },
        ],
      }),
    },
    {
      name: "a product row omitting a mistake its issues raised",
      snapshot: reportWith({
        productRows: [{ ...report.productRows[0], mistakes: ["SKU Eksik"] }],
      }),
    },
    {
      name: "a product row carrying an arbitrary mistake label",
      snapshot: reportWith({
        productRows: [{ ...report.productRows[0], mistakes: ["SKU Eksik", "Rastgele Etiket"] }],
      }),
    },
    {
      name: "a product row repeating a mistake label",
      snapshot: reportWith({
        productRows: [
          { ...report.productRows[0], mistakes: ["SKU Eksik", "SKU Eksik", "Stokta Yok"] },
        ],
      }),
    },
    {
      name: "a rule summary label that is not the canonical label for its code",
      snapshot: reportWith({
        ruleSummaries: report.ruleSummaries.map((summary) =>
          summary.code === "missing_sku" ? { ...summary, label: "Stokta Yok" } : summary,
        ),
      }),
    },
    {
      // A dropped zero-count rule silently removes a filter the merchant expects to see.
      name: "a rule summary missing for a rule no issue triggered",
      snapshot: reportWith({
        ruleSummaries: report.ruleSummaries.filter((summary) => summary.code !== "incorrect_price"),
      }),
    },
    {
      name: "a rule summary count that contradicts the issues",
      snapshot: reportWith({
        ruleSummaries: report.ruleSummaries.map((summary) =>
          summary.code === "missing_sku" ? { ...summary, count: 5 } : summary,
        ),
      }),
    },
    {
      name: "a duplicated rule summary code",
      snapshot: reportWith({
        ruleSummaries: [...report.ruleSummaries, { code: "missing_sku", label: "SKU Eksik", count: 1 }],
      }),
    },
    {
      name: "a rule summary missing for a rule the issues triggered",
      snapshot: reportWith({
        ruleSummaries: report.ruleSummaries.filter((summary) => summary.code !== "missing_sku"),
      }),
    },
  ])("rejects $name on both write and read", async ({ snapshot }) => {
    await expectRejectedOnPutAndGet(snapshot);
  });

  it("never repairs a corrupt persisted record into an acceptable one", async () => {
    const corrupt = reportWith({ issueCount: 99 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => redisResponse(JSON.stringify(corrupt)));

    await expect(redisStore(fetchMock).getLatest(tenant)).rejects.toBeInstanceOf(SnapshotStoreError);
    // A read must never silently rewrite the key to make it parse next time.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(commandOf(fetchMock)[0]).toBe("GET");
  });

  it("accepts product row mistakes in any order, since the set is what the filter reads", async () => {
    const store = new MemorySnapshotStore();
    const reordered = reportWith({
      productRows: [{ ...report.productRows[0], mistakes: ["Stokta Yok", "SKU Eksik"] }],
    });

    await store.putLatest(reordered);

    await expect(store.getLatest(tenant)).resolves.toEqual(reordered);
  });

  it("accepts a report whose aggregates agree with its rows", async () => {
    const store = new MemorySnapshotStore();

    await store.putLatest(snapshotFor());

    await expect(store.getLatest(tenant)).resolves.toEqual(snapshotFor());
  });
});

describe("scan leases", () => {
  it("grants a lease to the first caller and refuses concurrent duplicates", async () => {
    const store = new MemorySnapshotStore();

    const first = await store.acquireScanLease(tenant, "owner-1", 30_000);
    const second = await store.acquireScanLease(tenant, "owner-2", 30_000);

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("does not let one tenant's scan block another tenant", async () => {
    const store = new MemorySnapshotStore();

    await store.acquireScanLease(tenant, "owner-1", 30_000);

    await expect(store.acquireScanLease(otherTenant, "owner-2", 30_000)).resolves.toBeDefined();
  });

  it("releases a lease only for its own owner", async () => {
    const store = new MemorySnapshotStore();
    const lease = await store.acquireScanLease(tenant, "owner-1", 30_000);

    await expect(store.releaseScanLease({ ...lease!, ownerId: "owner-2" })).resolves.toBe(false);
    await expect(store.releaseScanLease(lease!)).resolves.toBe(true);
    await expect(store.acquireScanLease(tenant, "owner-3", 30_000)).resolves.toBeDefined();
  });

  it("expires a lease so a crashed scan cannot lock an installation forever", async () => {
    let clock = 1_000;
    const store = new MemorySnapshotStore(() => clock);

    await store.acquireScanLease(tenant, "owner-1", 30_000);
    clock += 30_001;

    await expect(store.acquireScanLease(tenant, "owner-2", 30_000)).resolves.toBeDefined();
  });

  it("acquires the Redis lease with an atomic NX write and a bounded TTL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse("OK"));

    await redisStore(fetchMock).acquireScanLease(tenant, "owner-1", 30_000);

    const command = commandOf(fetchMock);
    expect(command[0]).toBe("SET");
    expect(command).toContain("NX");
    expect(command).toContain("PX");
    expect(command).toContain(30_000);
  });

  it("reports a busy installation when Redis refuses the NX write", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse(null));

    await expect(redisStore(fetchMock).acquireScanLease(tenant, "owner-1", 30_000)).resolves.toBeUndefined();
  });

  it("rejects an unbounded or malformed lease request", async () => {
    const store = new MemorySnapshotStore();

    await expect(store.acquireScanLease(tenant, "owner 1", 30_000)).rejects.toBeInstanceOf(
      SnapshotStoreError,
    );
    await expect(store.acquireScanLease(tenant, "owner-1", 0)).rejects.toBeInstanceOf(
      SnapshotStoreError,
    );
    await expect(
      store.acquireScanLease({ authorizedAppId: "", merchantId: "m" }, "owner-1", 30_000),
    ).rejects.toBeInstanceOf(SnapshotStoreError);
  });
});

/**
 * Reading whether a scan is running is a separate, read-only operation from acquiring the
 * lease. The dashboard uses it to disable a duplicate scan before the merchant submits;
 * `POST /api/scans` still holds the authoritative `SET NX`, so this read can never be the
 * thing that decides a race.
 */
describe("reading the active scan lease", () => {
  it("reports an installation as scanning while its lease is held", async () => {
    const store = new MemorySnapshotStore();

    await expect(store.hasActiveScanLease(tenant)).resolves.toBe(false);
    await store.acquireScanLease(tenant, "owner-1", 30_000);
    await expect(store.hasActiveScanLease(tenant)).resolves.toBe(true);
  });

  it("stops reporting a scan once the lease is released", async () => {
    const store = new MemorySnapshotStore();
    const lease = await store.acquireScanLease(tenant, "owner-1", 30_000);

    await store.releaseScanLease(lease!);

    await expect(store.hasActiveScanLease(tenant)).resolves.toBe(false);
  });

  it("stops reporting a scan once the lease has expired", async () => {
    let clock = 1_000;
    const store = new MemorySnapshotStore(() => clock);
    await store.acquireScanLease(tenant, "owner-1", 30_000);

    clock += 30_001;

    await expect(store.hasActiveScanLease(tenant)).resolves.toBe(false);
  });

  it("never reports one tenant's scan to another tenant", async () => {
    const store = new MemorySnapshotStore();

    await store.acquireScanLease(tenant, "owner-1", 30_000);

    await expect(store.hasActiveScanLease(otherTenant)).resolves.toBe(false);
  });

  it("refuses a malformed tenant instead of reading a guessed key", async () => {
    const store = new MemorySnapshotStore();

    await expect(
      store.hasActiveScanLease({ authorizedAppId: "", merchantId: "merchant-1" }),
    ).rejects.toBeInstanceOf(SnapshotStoreError);
    await expect(
      store.hasActiveScanLease({ authorizedAppId: "app-1", merchantId: "bad merchant" }),
    ).rejects.toBeInstanceOf(SnapshotStoreError);
  });

  it("reads the lease with a single Redis GET and never leaks the owner id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse("owner-1"));

    await expect(redisStore(fetchMock).hasActiveScanLease(tenant)).resolves.toBe(true);

    const command = commandOf(fetchMock);
    expect(command[0]).toBe("GET");
    expect(fetchMock).toHaveBeenCalledOnce();
    // Raw tenant identifiers must not appear in the key space.
    expect(String(command[1])).not.toContain("app-1");
    expect(String(command[1])).not.toContain("merchant-1");
  });

  it("reads no lease as not scanning", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => redisResponse(null));

    await expect(redisStore(fetchMock).hasActiveScanLease(tenant)).resolves.toBe(false);
  });
});

describe("snapshot freshness", () => {
  const generatedAt = Date.parse("2026-07-20T08:00:00.000Z");

  it("treats a snapshot within the freshness window as current", () => {
    expect(isSnapshotStale(snapshotFor(), generatedAt + SNAPSHOT_STALE_AFTER_MS)).toBe(false);
  });

  it("marks a snapshot past the freshness window as stale", () => {
    expect(isSnapshotStale(snapshotFor(), generatedAt + SNAPSHOT_STALE_AFTER_MS + 1)).toBe(true);
  });

  it("treats an unreadable timestamp as stale rather than claiming freshness", () => {
    expect(isSnapshotStale(snapshotFor({ generatedAt: "not-a-date" }), generatedAt)).toBe(true);
  });
});

describe("history retention policy", () => {
  it("denies history reads by default so Pro retention cannot leak before entitlement wiring", async () => {
    const store = new MemorySnapshotStore();
    await store.putLatest(snapshotFor());

    await expect(store.listHistory(tenant)).rejects.toMatchObject({ code: "history_disabled" });
  });
});

describe("createSnapshotStore", () => {
  it("uses Redis when durable credentials are configured", () => {
    const store = createSnapshotStore({ env: { ...credentials, NODE_ENV: "production" } });

    expect(store).toBeInstanceOf(RedisRestSnapshotStore);
  });

  it("refuses to start without durable credentials in production", () => {
    expect(() => createSnapshotStore({ env: { NODE_ENV: "production" } })).toThrow(SnapshotStoreError);
  });

  it("refuses an in-memory driver outside development and test", () => {
    expect(() =>
      createSnapshotStore({ env: { NODE_ENV: "production", IKAS_SNAPSHOT_STORE_DRIVER: "memory" } }),
    ).toThrow(SnapshotStoreError);
  });

  it("allows an in-memory driver for local development and tests", () => {
    expect(
      createSnapshotStore({ env: { NODE_ENV: "test", IKAS_SNAPSHOT_STORE_DRIVER: "memory" } }),
    ).toBeInstanceOf(MemorySnapshotStore);
  });

  it("rejects an insecure Redis endpoint", () => {
    expect(() =>
      createSnapshotStore({
        env: { UPSTASH_REDIS_REST_URL: "http://redis.example.test", UPSTASH_REDIS_REST_TOKEN: "t" },
      }),
    ).toThrow(SnapshotStoreError);
  });
});
