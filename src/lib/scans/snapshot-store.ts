import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assessHealth, type HealthAssessment } from "@/lib/health/health-model";
import { ISSUE_TO_RULE, MISTAKE_RULE_CODES, RULE_LABELS } from "@/lib/ikas/health-rules";
import { TOKEN_STORE_ENV_KEYS } from "@/lib/ikas/token-store";
import type { HealthIssueCode, HealthReport, MistakeRuleCode } from "@/lib/ikas/types";

/**
 * Immutable, tenant-partitioned scan snapshots.
 *
 * A snapshot is the derived health report for one installation at one point in time.
 * It deliberately holds no access token, no refresh token, and no raw ikas GraphQL
 * product payload — only the aggregate counts and issue rows the dashboard, JSON
 * report, and CSV all render from. Records are never mutated in place: a successful
 * scan replaces the "latest" pointer with a new immutable record.
 */

const HEALTH_ISSUE_CODES = [
  "missing_sku",
  "missing_barcode",
  "duplicate_sku",
  "duplicate_barcode",
  "missing_image",
  "missing_description",
  "missing_category",
  "missing_brand",
  "missing_vendor",
  "zero_stock_blocked",
  "missing_price",
  "duplicate_title",
  "weird_description",
] as const;

/**
 * Hard ceiling on one serialized snapshot, measured in UTF-8 bytes.
 *
 * The entire record travels as a single JSON command body to the Redis REST endpoint, so
 * it must fit inside one request with room left for the command framing — the EVAL script,
 * the keys, the lease owner, and the JSON array around them. Redis REST gateways commonly
 * cap a request body somewhere around 1 MiB; 768 KiB sits far enough below that class of
 * limit to stay safe without relying on any single provider's published figure.
 *
 * A snapshot over this limit fails closed. Nothing is written, so the previous successful
 * snapshot stays readable, and no truncated report is ever stored: a partial issue list
 * would understate a merchant's real problems while looking like a complete scan.
 */
export const MAX_SNAPSHOT_BYTES = 768 * 1024;

/**
 * One row per affected product, and a scan reads at most `PRODUCT_SCAN_MAX_PRODUCTS`
 * products, so the catalog scan budget is the exact upper bound. Kept as a literal rather
 * than an import so the snapshot store does not pull the product adapter — and its sample
 * catalog — into every bundle that reads a snapshot; a test pins the two together.
 */
export const MAX_SNAPSHOT_PRODUCT_ROWS = 10_000;

/**
 * Issues are bounded well above the rows they roll up from, since one product can fail
 * several rules across several variants. The byte ceiling above is the binding constraint
 * in practice; this bound just stops an absurd array before it is ever measured.
 */
const MAX_SNAPSHOT_ISSUES = MAX_SNAPSHOT_PRODUCT_ROWS * 10;

const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const LEASE_OWNER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const REDIS_KEY_PREFIX = "ikas:scan-snapshot:v1:";
const REDIS_LEASE_KEY_PREFIX = "ikas:scan-lease:v1:";
const REDIS_REQUEST_TIMEOUT_MS = 5_000;
const RELEASE_LEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const PUT_WITH_LEASE_SCRIPT =
  "if redis.call('GET', KEYS[2]) ~= ARGV[1] then return -1 end; redis.call('SET', KEYS[1], ARGV[2]); return 1";

const isoTimestamp = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);

const healthIssueSchema = z.object({
  code: z.enum(HEALTH_ISSUE_CODES),
  severity: z.enum(["critical", "warning", "info"]),
  productId: z.string().max(256),
  productName: z.string().max(1024),
  variantId: z.string().max(256).optional(),
  variantLabel: z.string().max(1024).optional(),
  message: z.string().max(2048),
  value: z.union([z.string().max(1024), z.number()]).optional(),
  productUpdatedAt: isoTimestamp.optional(),
});

const productRowSchema = z.object({
  productId: z.string().max(256),
  productName: z.string().max(1024),
  imageLabel: z.string().max(64),
  imageId: z.string().max(256).optional(),
  imageFileName: z.string().max(1024).nullish(),
  imageSrc: z.string().max(2048).optional(),
  updatedAt: isoTimestamp.optional(),
  mistakes: z.array(z.string().max(256)).max(64),
  actionLabel: z.string().max(256),
});

const count = z.number().int().min(0);

const healthReportSchema = z.object({
  generatedAt: isoTimestamp,
  score: z.number().int().min(0).max(100),
  productCount: count,
  variantCount: count,
  issueCount: count,
  affectedProductCount: count,
  // A snapshot records a scan that finished. An in-flight scan has nothing to persist,
  // so a stored "queued" report could only be a partial or corrupted record.
  scanStatus: z.literal("success"),
  issueCountsByCode: z.object(
    Object.fromEntries(HEALTH_ISSUE_CODES.map((code) => [code, count])) as {
      [K in (typeof HEALTH_ISSUE_CODES)[number]]: typeof count;
    },
  ),
  criticalCount: count,
  warningCount: count,
  infoCount: count,
  outOfStockBlockedCount: count,
  ruleSummaries: z
    .array(z.object({ code: z.enum(MISTAKE_RULE_CODES), label: z.string().max(256), count }))
    .max(64),
  productRows: z.array(productRowSchema).max(MAX_SNAPSHOT_PRODUCT_ROWS),
  issues: z.array(healthIssueSchema).max(MAX_SNAPSHOT_ISSUES),
});

const baseSnapshotSchema = z.object({
  version: z.literal(1),
  scanId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  authorizedAppId: z.string().regex(TENANT_ID_PATTERN),
  merchantId: z.string().regex(TENANT_ID_PATTERN),
  generatedAt: isoTimestamp,
  report: healthReportSchema,
});

/**
 * Every aggregate a snapshot carries is derivable from its own issue and product rows, so
 * each one is re-derived here and compared. A record whose totals disagree with its rows
 * is corrupt — it would render a dashboard that contradicts the table beneath it — and is
 * refused outright rather than repaired, on write and on read alike.
 *
 * The score is deliberately not checked: PR C replaces that formula.
 */
function checkReportInvariants(snapshot: z.infer<typeof baseSnapshotSchema>, ctx: z.RefinementCtx) {
  const { report } = snapshot;
  const fail = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: "custom", message, path: ["report", ...path] });

  if (report.generatedAt !== snapshot.generatedAt) {
    fail("report timestamp disagrees with the snapshot timestamp", ["generatedAt"]);
  }

  const severityCounts = { critical: 0, warning: 0, info: 0 };
  const countsByCode = Object.fromEntries(HEALTH_ISSUE_CODES.map((code) => [code, 0])) as Record<
    HealthIssueCode,
    number
  >;
  const affectedProductIds = new Set<string>();
  const productIdsByRule = new Map<MistakeRuleCode, Set<string>>();
  const mistakeLabelsByProduct = new Map<string, Set<string>>();

  for (const issue of report.issues) {
    severityCounts[issue.severity] += 1;
    countsByCode[issue.code] += 1;
    affectedProductIds.add(issue.productId);

    const rule = ISSUE_TO_RULE[issue.code];
    if (!rule) continue;
    const products = productIdsByRule.get(rule) ?? new Set<string>();
    products.add(issue.productId);
    productIdsByRule.set(rule, products);

    const labels = mistakeLabelsByProduct.get(issue.productId) ?? new Set<string>();
    labels.add(RULE_LABELS[rule]);
    mistakeLabelsByProduct.set(issue.productId, labels);
  }

  if (report.issueCount !== report.issues.length) {
    fail("issue count disagrees with the issue rows", ["issueCount"]);
  }
  if (report.criticalCount !== severityCounts.critical) {
    fail("critical count disagrees with the issue severities", ["criticalCount"]);
  }
  if (report.warningCount !== severityCounts.warning) {
    fail("warning count disagrees with the issue severities", ["warningCount"]);
  }
  if (report.infoCount !== severityCounts.info) {
    fail("info count disagrees with the issue severities", ["infoCount"]);
  }
  if (report.criticalCount + report.warningCount + report.infoCount !== report.issueCount) {
    fail("severity counts do not sum to the issue count", ["issueCount"]);
  }

  for (const code of HEALTH_ISSUE_CODES) {
    if (report.issueCountsByCode[code] !== countsByCode[code]) {
      fail("per-code count disagrees with the issue rows", ["issueCountsByCode", code]);
    }
  }

  if (report.outOfStockBlockedCount !== countsByCode.zero_stock_blocked) {
    fail("blocked-stock count disagrees with the issue rows", ["outOfStockBlockedCount"]);
  }
  if (report.affectedProductCount !== affectedProductIds.size) {
    fail("affected product count disagrees with the issue rows", ["affectedProductCount"]);
  }
  if (report.productCount < report.affectedProductCount) {
    fail("scanned product count is below the affected product count", ["productCount"]);
  }

  // Production builds one row per product carrying at least one rule-mapped issue, so the
  // row set is exactly that product set — no duplicates, no rows without a cause.
  const rowProductIds = new Set(report.productRows.map((row) => row.productId));
  if (rowProductIds.size !== report.productRows.length) {
    fail("product rows repeat a product", ["productRows"]);
  }
  const ruleMappedProductIds = new Set([...productIdsByRule.values()].flatMap((ids) => [...ids]));
  if (
    rowProductIds.size !== ruleMappedProductIds.size ||
    [...ruleMappedProductIds].some((productId) => !rowProductIds.has(productId))
  ) {
    fail("product rows do not match the products the issues affect", ["productRows"]);
  }

  // The dashboard filters the table by matching a summary label against these strings, so a
  // row's mistakes are re-derived from its own issues and compared as a set: an extra label
  // shows a clean product under a problem filter, a missing one hides a real problem, and
  // both survive every count above. Order is production's, not contractual.
  for (const [index, row] of report.productRows.entries()) {
    const expected = mistakeLabelsByProduct.get(row.productId) ?? new Set<string>();
    const actual = new Set(row.mistakes);
    if (
      actual.size !== row.mistakes.length ||
      actual.size !== expected.size ||
      [...expected].some((label) => !actual.has(label))
    ) {
      fail("product row mistakes disagree with the issues for that product", [
        "productRows",
        index,
        "mistakes",
      ]);
    }
  }

  // Production summarises every canonical rule, including the ones no issue triggered, so the
  // filter row keeps its width across scans. Labels come from the same canonical table the
  // rows are checked against, so a summary can never label a filter differently than the rows
  // it selects.
  const summaryCodes = new Set(report.ruleSummaries.map((summary) => summary.code));
  if (
    summaryCodes.size !== report.ruleSummaries.length ||
    summaryCodes.size !== MISTAKE_RULE_CODES.length
  ) {
    fail("rule summaries are not exactly one per canonical rule", ["ruleSummaries"]);
  }
  for (const [index, summary] of report.ruleSummaries.entries()) {
    if (summary.label !== RULE_LABELS[summary.code]) {
      fail("rule summary label is not the canonical label for its code", [
        "ruleSummaries",
        index,
        "label",
      ]);
    }
    if (summary.count !== (productIdsByRule.get(summary.code)?.size ?? 0)) {
      fail("rule summary count disagrees with the issue rows", ["ruleSummaries", index, "count"]);
    }
  }
  for (const rule of MISTAKE_RULE_CODES) {
    if (!summaryCodes.has(rule)) {
      fail("rule summary missing for a canonical rule", ["ruleSummaries"]);
    }
  }
}

const snapshotSchema = baseSnapshotSchema.superRefine(checkReportInvariants);

export type ScanSnapshot = {
  version: 1;
  scanId: string;
  authorizedAppId: string;
  merchantId: string;
  generatedAt: string;
  report: HealthReport;
};

/**
 * Snapshot fields that are safe to send to a client: no tenant identifiers, and exactly one
 * health score.
 *
 * The stored report keeps the `score` it was written with, because rewriting historical
 * snapshots to a new formula would falsify what those scans actually recorded. That number is
 * not the one a merchant sees. `health` carries the current model — the same `assessHealth`
 * result the dashboard renders — and the legacy field is dropped from `report` on the way out,
 * so one scan can never be published with two contradicting health values.
 */
export type SafeScanSnapshot = {
  scanId: string;
  generatedAt: string;
  /** The published health result. `score` is null when there is nothing to score. */
  health: HealthAssessment;
  report: Omit<HealthReport, "score">;
};

export type SnapshotTenant = {
  authorizedAppId: string;
  merchantId: string;
};

export type ScanLease = SnapshotTenant & {
  ownerId: string;
};

export type SnapshotRetentionPolicy = {
  /** Pro-only bounded history. Default-deny until entitlement wiring is connected. */
  historyEnabled: boolean;
};

export const DEFAULT_RETENTION_POLICY: SnapshotRetentionPolicy = { historyEnabled: false };

export interface SnapshotStore {
  getLatest(tenant: SnapshotTenant): Promise<ScanSnapshot | undefined>;
  putLatest(snapshot: ScanSnapshot, lease?: ScanLease): Promise<void>;
  listHistory(tenant: SnapshotTenant): Promise<ScanSnapshot[]>;
  acquireScanLease(tenant: SnapshotTenant, ownerId: string, ttlMs: number): Promise<ScanLease | undefined>;
  releaseScanLease(lease: ScanLease): Promise<boolean>;
  /**
   * Read-only view of whether this installation currently holds a scan lease.
   *
   * Deliberately returns a boolean rather than the lease: the owner id is an internal
   * concurrency token and nothing outside the scan path has any use for it. Acquiring the
   * lease stays the only operation that decides a race; this one only lets a surface show
   * what is already true.
   */
  hasActiveScanLease(tenant: SnapshotTenant): Promise<boolean>;
}

export type SnapshotStoreErrorCode =
  | "configuration"
  | "backend"
  | "corrupt_record"
  | "history_disabled"
  | "lease_lost"
  | "payload_too_large";
export type SnapshotStoreOperation = "configure" | "get" | "put" | "lease" | "history";

export class SnapshotStoreError extends Error {
  readonly code: SnapshotStoreErrorCode;
  readonly operation: SnapshotStoreOperation;

  constructor(code: SnapshotStoreErrorCode, operation: SnapshotStoreOperation) {
    super(`IKAS_SNAPSHOT_STORE_${code.toUpperCase()}`);
    this.name = "SnapshotStoreError";
    this.code = code;
    this.operation = operation;
  }
}

type Environment = Record<string, string | undefined>;
type RedisCommand = Array<string | number>;

export type RedisRestSnapshotStoreOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  retention?: SnapshotRetentionPolicy;
};

export type SnapshotStoreFactoryOptions = {
  env?: Environment;
  fetchImpl?: typeof fetch;
  retention?: SnapshotRetentionPolicy;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTenant(tenant: SnapshotTenant, operation: SnapshotStoreOperation): SnapshotTenant {
  if (
    !isRecord(tenant) ||
    typeof tenant.authorizedAppId !== "string" ||
    !TENANT_ID_PATTERN.test(tenant.authorizedAppId) ||
    typeof tenant.merchantId !== "string" ||
    !TENANT_ID_PATTERN.test(tenant.merchantId)
  ) {
    throw new SnapshotStoreError("configuration", operation);
  }
  return { authorizedAppId: tenant.authorizedAppId, merchantId: tenant.merchantId };
}

/**
 * Both identifiers participate in the key, so a snapshot written for one installation
 * can never be addressed by another. The digest keeps raw tenant ids out of the key space.
 */
function tenantDigest(tenant: SnapshotTenant) {
  return createHash("sha256")
    .update(`${tenant.authorizedAppId} ${tenant.merchantId}`, "utf8")
    .digest("base64url");
}

function latestKey(tenant: SnapshotTenant) {
  return `${REDIS_KEY_PREFIX}latest:${tenantDigest(tenant)}`;
}

function leaseKey(tenant: SnapshotTenant) {
  return `${REDIS_LEASE_KEY_PREFIX}${tenantDigest(tenant)}`;
}

/**
 * Serializes a snapshot for storage, rejecting anything outside the contract and anything
 * too large to belong in one Redis request. Both checks run before a command is built, so
 * an oversized payload never reaches the network and never displaces a stored snapshot.
 */
function serializeSnapshotForWrite(snapshot: ScanSnapshot): {
  snapshot: ScanSnapshot;
  serialized: string;
} {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new SnapshotStoreError("configuration", "put");

  const serialized = JSON.stringify(parsed.data);
  // UTF-8 bytes, not string length: Turkish product copy and emoji cost more on the wire
  // than their UTF-16 length suggests, and the wire is what the limit applies to.
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotStoreError("payload_too_large", "put");
  }

  return { snapshot: parsed.data as ScanSnapshot, serialized };
}

function parseStoredSnapshot(raw: unknown, tenant: SnapshotTenant): ScanSnapshot {
  if (typeof raw !== "string") throw new SnapshotStoreError("corrupt_record", "get");

  // Measured before parsing: an oversized record is refused rather than expanded into
  // memory, whatever it happens to contain.
  if (Buffer.byteLength(raw, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotStoreError("payload_too_large", "get");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SnapshotStoreError("corrupt_record", "get");
  }

  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new SnapshotStoreError("corrupt_record", "get");

  // Defence in depth: the key already partitions tenants, but a record whose own
  // identity disagrees with the caller's is treated as corruption, never rendered.
  if (
    parsed.data.authorizedAppId !== tenant.authorizedAppId ||
    parsed.data.merchantId !== tenant.merchantId
  ) {
    throw new SnapshotStoreError("corrupt_record", "get");
  }

  return parsed.data as ScanSnapshot;
}

function validateLeaseRequest(tenant: SnapshotTenant, ownerId: string, ttlMs: number) {
  const validated = validateTenant(tenant, "lease");
  if (typeof ownerId !== "string" || !LEASE_OWNER_PATTERN.test(ownerId)) {
    throw new SnapshotStoreError("configuration", "lease");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new SnapshotStoreError("configuration", "lease");
  }
  return { ...validated, ownerId };
}

function validateLease(lease: ScanLease): ScanLease {
  const validated = validateTenant(lease, "lease");
  if (typeof lease.ownerId !== "string" || !LEASE_OWNER_PATTERN.test(lease.ownerId)) {
    throw new SnapshotStoreError("configuration", "lease");
  }
  return { ...validated, ownerId: lease.ownerId };
}

export function toSafeSnapshot(snapshot: ScanSnapshot): SafeScanSnapshot {
  // Destructured off rather than deleted, so the stored record is left untouched.
  const { score: _legacyScore, ...report } = snapshot.report;
  void _legacyScore;

  return {
    scanId: snapshot.scanId,
    generatedAt: snapshot.generatedAt,
    health: assessHealth(snapshot.report),
    report,
  };
}

/** A snapshot older than this is still served, but labelled as possibly out of date. */
export const SNAPSHOT_STALE_AFTER_MS = 24 * 60 * 60_000;

/** An unreadable timestamp counts as stale so freshness claims never overstate. */
export function isSnapshotStale(snapshot: ScanSnapshot, now: number) {
  const generated = new Date(snapshot.generatedAt).getTime();
  if (Number.isNaN(generated)) return true;
  return now - generated > SNAPSHOT_STALE_AFTER_MS;
}

export class RedisRestSnapshotStore implements SnapshotStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly retention: SnapshotRetentionPolicy;

  constructor({
    url,
    token,
    fetchImpl = fetch,
    requestTimeoutMs = REDIS_REQUEST_TIMEOUT_MS,
    retention = DEFAULT_RETENTION_POLICY,
  }: RedisRestSnapshotStoreOptions) {
    if (!url?.trim() || !token?.trim()) throw new SnapshotStoreError("configuration", "configure");
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 60_000) {
      throw new SnapshotStoreError("configuration", "configure");
    }

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:") throw new Error("insecure endpoint");
    } catch {
      throw new SnapshotStoreError("configuration", "configure");
    }

    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retention = retention;
  }

  private async command(command: RedisCommand, operation: SnapshotStoreOperation) {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
        cache: "no-store",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new SnapshotStoreError("backend", operation);
    }

    if (!response.ok) throw new SnapshotStoreError("backend", operation);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SnapshotStoreError("backend", operation);
    }

    if (!isRecord(payload) || !("result" in payload) || ("error" in payload && payload.error)) {
      throw new SnapshotStoreError("backend", operation);
    }
    return payload.result;
  }

  async getLatest(tenant: SnapshotTenant) {
    const validated = validateTenant(tenant, "get");
    const raw = await this.command(["GET", latestKey(validated)], "get");
    if (raw === null) return undefined;
    return parseStoredSnapshot(raw, validated);
  }

  async putLatest(snapshot: ScanSnapshot, lease?: ScanLease) {
    const { snapshot: validated, serialized } = serializeSnapshotForWrite(snapshot);
    const tenant = { authorizedAppId: validated.authorizedAppId, merchantId: validated.merchantId };

    if (!lease) {
      const result = await this.command(["SET", latestKey(tenant), serialized], "put");
      if (result !== "OK") throw new SnapshotStoreError("backend", "put");
      return;
    }

    const validatedLease = validateLease(lease);
    if (
      validatedLease.authorizedAppId !== tenant.authorizedAppId ||
      validatedLease.merchantId !== tenant.merchantId
    ) {
      throw new SnapshotStoreError("configuration", "put");
    }

    const result = await this.command(
      [
        "EVAL",
        PUT_WITH_LEASE_SCRIPT,
        2,
        latestKey(tenant),
        leaseKey(tenant),
        validatedLease.ownerId,
        serialized,
      ],
      "put",
    );
    if (result === -1) throw new SnapshotStoreError("lease_lost", "put");
    if (result !== 1) throw new SnapshotStoreError("backend", "put");
  }

  async listHistory(tenant: SnapshotTenant) {
    validateTenant(tenant, "history");
    if (!this.retention.historyEnabled) throw new SnapshotStoreError("history_disabled", "history");
    return [];
  }

  async acquireScanLease(tenant: SnapshotTenant, ownerId: string, ttlMs: number) {
    const lease = validateLeaseRequest(tenant, ownerId, ttlMs);
    const result = await this.command(
      ["SET", leaseKey(lease), lease.ownerId, "NX", "PX", ttlMs],
      "lease",
    );
    if (result === null) return undefined;
    if (result !== "OK") throw new SnapshotStoreError("backend", "lease");
    return lease;
  }

  async releaseScanLease(lease: ScanLease) {
    const validated = validateLease(lease);
    const result = await this.command(
      ["EVAL", RELEASE_LEASE_SCRIPT, 1, leaseKey(validated), validated.ownerId],
      "lease",
    );
    if (result !== 0 && result !== 1) throw new SnapshotStoreError("backend", "lease");
    return result === 1;
  }

  async hasActiveScanLease(tenant: SnapshotTenant) {
    const validated = validateTenant(tenant, "lease");
    // Redis expires the key itself, so presence is the whole answer and the stored owner id
    // never leaves this method.
    const result = await this.command(["GET", leaseKey(validated)], "lease");
    if (result === null) return false;
    if (typeof result !== "string") throw new SnapshotStoreError("backend", "lease");
    return true;
  }
}

type LocalLease = ScanLease & { expiresAt: number };

export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, string>();
  private readonly leases = new Map<string, LocalLease>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly retention: SnapshotRetentionPolicy = DEFAULT_RETENTION_POLICY,
  ) {}

  private activeLease(key: string) {
    const lease = this.leases.get(key);
    if (!lease) return undefined;
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(key);
      return undefined;
    }
    return lease;
  }

  async getLatest(tenant: SnapshotTenant) {
    const validated = validateTenant(tenant, "get");
    const raw = this.snapshots.get(latestKey(validated));
    if (raw === undefined) return undefined;
    return parseStoredSnapshot(raw, validated);
  }

  async putLatest(snapshot: ScanSnapshot, lease?: ScanLease) {
    const { snapshot: validated, serialized } = serializeSnapshotForWrite(snapshot);
    const tenant = { authorizedAppId: validated.authorizedAppId, merchantId: validated.merchantId };

    if (lease) {
      const validatedLease = validateLease(lease);
      if (
        validatedLease.authorizedAppId !== tenant.authorizedAppId ||
        validatedLease.merchantId !== tenant.merchantId
      ) {
        throw new SnapshotStoreError("configuration", "put");
      }
      const current = this.activeLease(leaseKey(tenant));
      if (!current || current.ownerId !== validatedLease.ownerId) {
        throw new SnapshotStoreError("lease_lost", "put");
      }
    }

    this.snapshots.set(latestKey(tenant), serialized);
  }

  async listHistory(tenant: SnapshotTenant) {
    validateTenant(tenant, "history");
    if (!this.retention.historyEnabled) throw new SnapshotStoreError("history_disabled", "history");
    return [];
  }

  async acquireScanLease(tenant: SnapshotTenant, ownerId: string, ttlMs: number) {
    const lease = validateLeaseRequest(tenant, ownerId, ttlMs);
    const key = leaseKey(lease);
    if (this.activeLease(key)) return undefined;
    this.leases.set(key, { ...lease, expiresAt: this.now() + ttlMs });
    return lease;
  }

  async releaseScanLease(lease: ScanLease) {
    const validated = validateLease(lease);
    const key = leaseKey(validated);
    const current = this.activeLease(key);
    if (!current || current.ownerId !== validated.ownerId) return false;
    this.leases.delete(key);
    return true;
  }

  async hasActiveScanLease(tenant: SnapshotTenant) {
    const validated = validateTenant(tenant, "lease");
    return Boolean(this.activeLease(leaseKey(validated)));
  }
}

function environmentValue(env: Environment, key: string) {
  const value = env[key]?.trim();
  return value || undefined;
}

function readCredentialPair(env: Environment, keys: readonly [string, string]) {
  const url = environmentValue(env, keys[0]);
  const token = environmentValue(env, keys[1]);
  if (!url && !token) return undefined;
  if (!url || !token) throw new SnapshotStoreError("configuration", "configure");
  return { url, token };
}

function resolveRedisCredentials(env: Environment) {
  const current = readCredentialPair(env, TOKEN_STORE_ENV_KEYS.current);
  if (current) return current;
  return readCredentialPair(env, TOKEN_STORE_ENV_KEYS.legacyVercelKv);
}

export function createSnapshotStore({
  env = process.env,
  fetchImpl = fetch,
  retention = DEFAULT_RETENTION_POLICY,
}: SnapshotStoreFactoryOptions = {}): SnapshotStore {
  const environment = environmentValue(env, "NODE_ENV");
  const driver = environmentValue(env, "IKAS_SNAPSHOT_STORE_DRIVER");
  if (driver && !["redis", "memory"].includes(driver)) {
    throw new SnapshotStoreError("configuration", "configure");
  }

  if (driver === "memory") {
    if (environment !== "development" && environment !== "test") {
      throw new SnapshotStoreError("configuration", "configure");
    }
    return new MemorySnapshotStore(Date.now, retention);
  }

  const redisCredentials = resolveRedisCredentials(env);
  if (!redisCredentials) throw new SnapshotStoreError("configuration", "configure");
  return new RedisRestSnapshotStore({ ...redisCredentials, fetchImpl, retention });
}

let configuredSnapshotStore: SnapshotStore | undefined;

function snapshotStore() {
  configuredSnapshotStore ??= createSnapshotStore();
  return configuredSnapshotStore;
}

export async function getLatestSnapshot(tenant: SnapshotTenant) {
  return snapshotStore().getLatest(tenant);
}

export async function saveLatestSnapshot(snapshot: ScanSnapshot, lease?: ScanLease) {
  return snapshotStore().putLatest(snapshot, lease);
}

export async function acquireScanLease(tenant: SnapshotTenant, ownerId: string, ttlMs: number) {
  return snapshotStore().acquireScanLease(tenant, ownerId, ttlMs);
}

export async function releaseScanLease(lease: ScanLease) {
  return snapshotStore().releaseScanLease(lease);
}

export async function hasActiveScanLease(tenant: SnapshotTenant) {
  return snapshotStore().hasActiveScanLease(tenant);
}
