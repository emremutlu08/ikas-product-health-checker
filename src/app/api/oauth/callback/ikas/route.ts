import { config } from "@/globals/config";
import { getCanonicalAppOrigin, getRedirectUri, requireOAuthConfig } from "@/helpers/api-helpers";
import { processIkasOAuthCallback } from "@/lib/ikas/oauth-callback";
import type { OAuthFailureReason } from "@/lib/ikas/oauth-failure";
import { consumeOAuthState } from "@/lib/ikas/oauth-state-store";
import { isValidStoreName } from "@/lib/ikas/store-name";
import { saveIkasToken } from "@/lib/ikas/token-store";
import { getSession } from "@/lib/session";
import { OAuthAPI } from "@ikas/admin-api-client";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectWithoutCaching(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("cache-control", "no-store");
  return response;
}

function failRedirect(
  reason: OAuthFailureReason,
  errorId: string,
  storeName?: string | null,
) {
  const failUrl = new URL("/authorize-store", getCanonicalAppOrigin());
  failUrl.searchParams.set("status", "fail");
  failUrl.searchParams.set("reason", reason);
  failUrl.searchParams.set("errorId", errorId);
  if (storeName && isValidStoreName(storeName)) failUrl.searchParams.set("storeName", storeName);
  return redirectWithoutCaching(failUrl);
}

export async function GET(request: NextRequest) {
  const result = await processIkasOAuthCallback(
    {
      code: request.nextUrl.searchParams.get("code"),
      state: request.nextUrl.searchParams.get("state"),
      storeName: request.nextUrl.searchParams.get("storeName"),
      redirectUri: getRedirectUri(),
      successBaseUrl: getCanonicalAppOrigin(),
    },
    {
      getOAuthConfig() {
        requireOAuthConfig();
        return {
          clientId: config.oauth.clientId!,
          clientSecret: config.oauth.clientSecret!,
        };
      },
      consumeOAuthState,
      getSession,
      async exchangeToken({ code, clientId, clientSecret, redirectUri, storeName }) {
        if (!isValidStoreName(storeName)) throw new Error("Invalid OAuth store name");
        const response = await OAuthAPI.getTokenWithAuthorizationCode(
          {
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
          },
          { storeName },
        );
        return { ok: response.ok, status: response.status, data: response.data as unknown };
      },
      queryAppContext(accessToken) {
        return fetch(config.graphApiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            query: `query getIkasAppContext { getMerchant { id storeName } getAuthorizedApp { id } }`,
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
      },
      persistToken: saveIkasToken,
    },
  );

  if (!result.ok) {
    return failRedirect(result.reason, result.errorId, result.storeName);
  }

  return redirectWithoutCaching(result.redirectUrl);
}
