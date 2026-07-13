import { validateAuthSignature, type AuthConnectParams } from "@ikas/admin-api-client";
import { z } from "zod";
import { getIkasToken, type StoredIkasToken } from "./token-store";
import { isValidStoreName } from "./store-name";

export const IKAS_LAUNCH_PARAM_NAMES = [
  "storeName",
  "merchantId",
  "timestamp",
  "signature",
  "authorizedAppId",
] as const;

export const IKAS_LAUNCH_MAX_AGE_MS = 120_000;

const SAFE_TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const launchSchema = z.object({
  storeName: z.string().min(1).max(63).refine(isValidStoreName),
  merchantId: z.string().min(1).max(256).regex(SAFE_TENANT_ID_PATTERN),
  timestamp: z.string().regex(/^\d{13}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  authorizedAppId: z.string().min(1).max(256).regex(SAFE_TENANT_ID_PATTERN),
});

export type IkasLaunchParams = z.infer<typeof launchSchema>;

export type InstallationIdentity = {
  authorizedAppId: string;
  merchantId: string;
  storeName: string;
};

export type InstallationAuthErrorCode =
  | "INVALID_LAUNCH"
  | "STALE_LAUNCH"
  | "TENANT_MISMATCH";

export class InstallationAuthError extends Error {
  constructor(readonly code: InstallationAuthErrorCode) {
    super(code);
    this.name = "InstallationAuthError";
  }
}

type LaunchValidationOptions = {
  now?: () => number;
  validateSignature?: (params: AuthConnectParams, appSecret: string) => boolean;
};

type LaunchResolutionDependencies = {
  getToken: typeof getIkasToken;
};

export type LaunchResolution =
  | {
      status: "authenticated";
      installation: InstallationIdentity;
      token: StoredIkasToken;
    }
  | {
      status: "oauth_required";
      installation: InstallationIdentity;
    };

function invalidLaunch(): never {
  throw new InstallationAuthError("INVALID_LAUNCH");
}

export function readIkasLaunchParams(searchParams: URLSearchParams) {
  const raw: Record<string, string> = {};
  for (const name of IKAS_LAUNCH_PARAM_NAMES) {
    const values = searchParams.getAll(name);
    if (values.length !== 1) invalidLaunch();
    raw[name] = values[0]!;
  }
  return raw;
}

export function validateIkasLaunchParams(
  input: unknown,
  appSecret: string,
  {
    now = Date.now,
    validateSignature = validateAuthSignature,
  }: LaunchValidationOptions = {},
): IkasLaunchParams {
  if (!appSecret) invalidLaunch();

  const parsed = launchSchema.safeParse(input);
  if (!parsed.success) invalidLaunch();

  const timestamp = Number(parsed.data.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now() - timestamp) > IKAS_LAUNCH_MAX_AGE_MS) {
    throw new InstallationAuthError("STALE_LAUNCH");
  }

  if (!validateSignature(parsed.data, appSecret)) invalidLaunch();
  return parsed.data;
}

export function installationFromLaunch(launch: IkasLaunchParams): InstallationIdentity {
  return {
    authorizedAppId: launch.authorizedAppId,
    merchantId: launch.merchantId,
    storeName: launch.storeName,
  };
}

export function tokenMatchesInstallation(
  token: StoredIkasToken | undefined,
  installation: InstallationIdentity,
): token is StoredIkasToken {
  return Boolean(
    token &&
      token.authorizedAppId === installation.authorizedAppId &&
      token.merchantId === installation.merchantId &&
      token.storeName === installation.storeName,
  );
}

export async function resolveIkasLaunch(
  input: unknown,
  appSecret: string,
  dependencies: LaunchResolutionDependencies = { getToken: getIkasToken },
  validationOptions?: LaunchValidationOptions,
): Promise<LaunchResolution> {
  const launch = validateIkasLaunchParams(input, appSecret, validationOptions);
  const installation = installationFromLaunch(launch);
  const token = await dependencies.getToken(installation.authorizedAppId);

  if (!token) return { status: "oauth_required", installation };
  if (!tokenMatchesInstallation(token, installation)) {
    throw new InstallationAuthError("TENANT_MISMATCH");
  }

  return { status: "authenticated", installation, token };
}

export function getIkasLaunchAuthenticationHref(
  searchParams: Record<string, string | string[] | undefined>,
) {
  const containsLaunchParam = IKAS_LAUNCH_PARAM_NAMES.some(
    (name) => searchParams[name] !== undefined,
  );
  if (!containsLaunchParam) return undefined;

  const destination = new URLSearchParams();
  for (const name of IKAS_LAUNCH_PARAM_NAMES) {
    const value = searchParams[name];
    if (Array.isArray(value)) {
      for (const item of value) destination.append(name, item);
    } else if (value !== undefined) {
      destination.set(name, value);
    }
  }
  return `/api/auth/ikas?${destination.toString()}`;
}
