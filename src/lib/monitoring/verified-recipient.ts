const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 1_000;
const MAX_EMAIL_LENGTH = 320;

export type VerifiedRecipientTenant = {
  authorizedAppId: string;
  merchantId: string;
};

export type VerifiedRecipient = { email: string };

type Environment = Record<string, string | undefined>;

export class VerifiedRecipientConfigurationError extends Error {
  readonly code = "IKAS_VERIFIED_RECIPIENT_CONFIGURATION_INVALID" as const;

  constructor() {
    super("IKAS_VERIFIED_RECIPIENT_CONFIGURATION_INVALID");
    this.name = "VerifiedRecipientConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new VerifiedRecipientConfigurationError();
}

function validTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_PATTERN.test(value);
}

export function resolveVerifiedRecipient(
  tenant: VerifiedRecipientTenant,
  env: Environment = process.env,
): VerifiedRecipient | undefined {
  if (!validTenantId(tenant.authorizedAppId) || !validTenantId(tenant.merchantId)) fail();

  const raw = env.IKAS_VERIFIED_EMAIL_RECIPIENTS_JSON?.trim();
  if (!raw) return undefined;
  if (raw.length > 512_000) fail();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RECIPIENTS) fail();

  const recipients = new Map<string, string>();
  for (const value of parsed) {
    if (!isRecord(value)) fail();
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "authorizedAppId,email,merchantId,verified") fail();
    if (!validTenantId(value.authorizedAppId) || !validTenantId(value.merchantId)) fail();
    if (value.verified !== true || typeof value.email !== "string") fail();

    const email = value.email.trim();
    if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) fail();
    const key = `${value.authorizedAppId}\u0000${value.merchantId}`;
    if (recipients.has(key)) fail();
    recipients.set(key, email);
  }

  const email = recipients.get(`${tenant.authorizedAppId}\u0000${tenant.merchantId}`);
  return email ? { email } : undefined;
}
