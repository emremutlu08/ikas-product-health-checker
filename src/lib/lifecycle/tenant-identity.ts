import { createHash } from "node:crypto";

export type TenantIdentity = {
  authorizedAppId: string;
  merchantId: string;
};

export type DeleteResult = "deleted" | "absent";

export const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
export const TENANT_DELETED_REDIS_RESULT = "tenant_deleted";
const TENANT_DELETION_KEY_PREFIX = "ikas:tenant-deleted:v1:";

export class TenantIdentityError extends Error {
  readonly code = "invalid_tenant" as const;

  constructor() {
    super("IKAS_TENANT_IDENTITY_INVALID");
    this.name = "TenantIdentityError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates before any store derives a key or builds a backend command. Returning a fresh,
 * two-field object also prevents callers from carrying tokens or other tenant data into cleanup.
 */
export function validateTenantIdentity(value: unknown): TenantIdentity {
  if (
    !isRecord(value) ||
    typeof value.authorizedAppId !== "string" ||
    !TENANT_ID_PATTERN.test(value.authorizedAppId) ||
    typeof value.merchantId !== "string" ||
    !TENANT_ID_PATTERN.test(value.merchantId)
  ) {
    throw new TenantIdentityError();
  }

  return {
    authorizedAppId: value.authorizedAppId,
    merchantId: value.merchantId,
  };
}

/**
 * Deletion is fenced by authorizedAppId alone so a later install cannot silently clear the
 * barrier by presenting a different merchantId. Only a digest reaches the Redis key space.
 */
export function tenantDeletionKey(authorizedAppId: string): string {
  if (!TENANT_ID_PATTERN.test(authorizedAppId)) throw new TenantIdentityError();
  const digest = createHash("sha256").update(authorizedAppId, "utf8").digest("base64url");
  return `${TENANT_DELETION_KEY_PREFIX}${digest}`;
}

/** Opaque marker value; it preserves neither raw tenant identifier in Redis. */
export function tenantDeletionMarker(identity: TenantIdentity): string {
  const tenant = validateTenantIdentity(identity);
  return createHash("sha256")
    .update([tenant.authorizedAppId, tenant.merchantId].join("\u0000"), "utf8")
    .digest("base64url");
}
