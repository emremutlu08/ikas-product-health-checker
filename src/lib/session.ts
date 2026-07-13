import { config } from "@/globals/config";
import { TOKEN_COOKIE } from "@/globals/constants";
import { isValidStoreName } from "@/lib/ikas/store-name";
import { getIronSession, type IronSession } from "iron-session";
import { cookies } from "next/headers";

export type SessionData = {
  state?: string;
  stateIssuedAt?: number;
  authorizedAppId?: string;
  merchantId?: string;
  storeName?: string;
};

export type InstallationSessionData = {
  authorizedAppId: string;
  merchantId: string;
  storeName: string;
};

export type OAuthStateSessionData = {
  state: string;
  stateIssuedAt: number;
  storeName: string;
};

export type SessionHandle = SessionData & Pick<IronSession<SessionData>, "save">;

export const INSTALLATION_SESSION_TTL_SECONDS = 8 * 60 * 60;

const LEGACY_TOKEN_KEYS = ["accessToken", "refreshToken", "tokenType", "expiresAt"] as const;
const SESSION_METHOD_KEYS = new Set(["save", "destroy", "updateConfig"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

function isValidTenantId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function clearEnumerableSessionData(session: SessionHandle) {
  const record = session as SessionHandle & Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SESSION_METHOD_KEYS.has(key)) delete record[key];
  }
}

export function stripLegacySessionTokens(session: SessionHandle) {
  const record = session as SessionHandle & Record<string, unknown>;
  for (const key of LEGACY_TOKEN_KEYS) delete record[key];
}

export function readInstallationSession(session?: SessionData | null): InstallationSessionData | undefined {
  if (
    !session ||
    !isValidTenantId(session.authorizedAppId) ||
    !isValidTenantId(session.merchantId) ||
    typeof session.storeName !== "string" ||
    !isValidStoreName(session.storeName)
  ) {
    return undefined;
  }

  return {
    authorizedAppId: session.authorizedAppId,
    merchantId: session.merchantId,
    storeName: session.storeName,
  };
}

export async function saveSanitizedSession(session: SessionHandle) {
  stripLegacySessionTokens(session);
  await session.save();
}

export async function clearSessionData(session: SessionHandle) {
  clearEnumerableSessionData(session);
  await session.save();
}

export async function saveOAuthStateSession(session: SessionHandle, oauthState: OAuthStateSessionData) {
  if (
    !oauthState.state ||
    oauthState.state.length > 512 ||
    CONTROL_CHARACTER_PATTERN.test(oauthState.state) ||
    !Number.isSafeInteger(oauthState.stateIssuedAt) ||
    oauthState.stateIssuedAt <= 0 ||
    !isValidStoreName(oauthState.storeName)
  ) {
    throw new Error("Invalid OAuth state session data");
  }

  clearEnumerableSessionData(session);
  session.state = oauthState.state;
  session.stateIssuedAt = oauthState.stateIssuedAt;
  session.storeName = oauthState.storeName;
  await saveSanitizedSession(session);
}

export async function consumeOAuthStateSession(session: SessionHandle) {
  await clearSessionData(session);
}

export async function saveInstallationSession(session: SessionHandle, installation: InstallationSessionData) {
  if (
    !isValidTenantId(installation.authorizedAppId) ||
    !isValidTenantId(installation.merchantId) ||
    !isValidStoreName(installation.storeName)
  ) {
    throw new Error("Invalid installation session data");
  }

  clearEnumerableSessionData(session);
  session.authorizedAppId = installation.authorizedAppId;
  session.merchantId = installation.merchantId;
  session.storeName = installation.storeName;
  await saveSanitizedSession(session);
}

function cookiePassword() {
  const password = config.cookiePassword;
  if (!password || password.length < 32) {
    throw new Error("SECRET_COOKIE_PASSWORD must be at least 32 characters for ikas OAuth session storage");
  }
  return password;
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), {
    password: cookiePassword(),
    cookieName: TOKEN_COOKIE,
    ttl: INSTALLATION_SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
  });
}
