import { config } from "@/globals/config";
import { getCanonicalAppOrigin } from "@/helpers/api-helpers";
import {
  InstallationAuthError,
  readIkasLaunchParams,
  resolveIkasLaunch,
} from "@/lib/ikas/installation-auth";
import { getSession, saveInstallationSession } from "@/lib/session";
import { type NextRequest, NextResponse } from "next/server";

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};

export type IkasLaunchRouteDependencies = {
  getCanonicalOrigin: typeof getCanonicalAppOrigin;
  getClientSecret(): string | undefined;
  resolveLaunch: typeof resolveIkasLaunch;
  getSession: typeof getSession;
  saveInstallationSession: typeof saveInstallationSession;
  createCorrelationId(): string;
};

const defaultDependencies: IkasLaunchRouteDependencies = {
  getCanonicalOrigin: getCanonicalAppOrigin,
  getClientSecret: () => config.oauth.clientSecret,
  resolveLaunch: resolveIkasLaunch,
  getSession,
  saveInstallationSession,
  createCorrelationId: () => crypto.randomUUID(),
};

function redirectWithoutCaching(url: URL) {
  const response = NextResponse.redirect(url);
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function failRedirect(origin: string, errorId: string, reason: "callback_invalid" | "oauth_config_missing" | "unexpected_error") {
  const url = new URL("/authorize-store", origin);
  url.searchParams.set("status", "fail");
  url.searchParams.set("reason", reason);
  url.searchParams.set("errorId", errorId);
  return redirectWithoutCaching(url);
}

export async function handleIkasLaunch(
  request: NextRequest,
  dependencies: IkasLaunchRouteDependencies = defaultDependencies,
) {
  let origin: string;
  try {
    origin = dependencies.getCanonicalOrigin();
  } catch {
    return Response.json(
      { error: "IKAS_ORIGIN_CONFIGURATION_INVALID" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }

  const errorId = dependencies.createCorrelationId();
  try {
    const clientSecret = dependencies.getClientSecret();
    if (!clientSecret) return failRedirect(origin, errorId, "oauth_config_missing");

    const launchParams = readIkasLaunchParams(request.nextUrl.searchParams);
    const resolution = await dependencies.resolveLaunch(launchParams, clientSecret);
    if (resolution.status === "oauth_required") {
      const authorizeUrl = new URL("/api/oauth/authorize/ikas", origin);
      authorizeUrl.searchParams.set("storeName", resolution.installation.storeName);
      return redirectWithoutCaching(authorizeUrl);
    }

    const session = await dependencies.getSession();
    await dependencies.saveInstallationSession(session, resolution.installation);
    return redirectWithoutCaching(new URL("/", origin));
  } catch (error) {
    const reason = error instanceof InstallationAuthError ? "callback_invalid" : "unexpected_error";
    return failRedirect(origin, errorId, reason);
  }
}
