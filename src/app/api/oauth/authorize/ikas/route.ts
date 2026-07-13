import { config } from "@/globals/config";
import { getCanonicalAppOrigin, getRedirectUri, requireOAuthConfig } from "@/helpers/api-helpers";
import { getSession, saveOAuthStateSession } from "@/lib/session";
import type { OAuthFailureReason } from "@/lib/ikas/oauth-failure";
import {
  generateOAuthState,
  OAUTH_STATE_TTL_MS,
  persistOAuthState,
} from "@/lib/ikas/oauth-state-store";
import { isValidStoreName, normalizeStoreNameInput } from "@/lib/ikas/store-name";
import { validateRequest } from "@/lib/validation";
import { OAuthAPI } from "@ikas/admin-api-client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const authorizeSchema = z.object({
  storeName: z
    .string()
    .transform(normalizeStoreNameInput)
    .refine(isValidStoreName, "Geçerli bir ikas mağaza adı girin."),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failRedirect(
  reason: OAuthFailureReason,
  errorId: string,
  storeName?: string | null,
) {
  const failUrl = new URL("/authorize-store", getCanonicalAppOrigin());
  failUrl.searchParams.set("status", "fail");
  failUrl.searchParams.set("reason", reason);
  failUrl.searchParams.set("errorId", errorId);
  const normalizedStoreName = normalizeStoreNameInput(storeName);
  if (isValidStoreName(normalizedStoreName)) failUrl.searchParams.set("storeName", normalizedStoreName);
  const response = NextResponse.redirect(failUrl);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const requestedStoreName = url.searchParams.get("storeName");
  const errorId = crypto.randomUUID();
  let failureReason: OAuthFailureReason = "oauth_authorize_failed";
  let failureStage = "oauth_authorize";

  try {
    failureReason = "oauth_config_missing";
    failureStage = "oauth_config";
    requireOAuthConfig();
    failureReason = "oauth_authorize_failed";
    failureStage = "oauth_authorize";
    const validation = validateRequest(authorizeSchema, { storeName: requestedStoreName });
    if (!validation.success) return failRedirect("invalid_store_name", errorId, requestedStoreName);

    const storeName = validation.data.storeName;
    const stateIssuedAt = Date.now();
    const state = generateOAuthState(stateIssuedAt);
    failureReason = "state_store_unavailable";
    failureStage = "state_persist";
    await persistOAuthState(state, { storeName, createdAt: stateIssuedAt }, OAUTH_STATE_TTL_MS);

    failureReason = "session_save_failed";
    failureStage = "session_save";
    const session = await getSession();
    await saveOAuthStateSession(session, {
      state,
      stateIssuedAt,
      storeName,
    });

    failureReason = "oauth_authorize_failed";
    failureStage = "oauth_authorize";
    if (!isValidStoreName(storeName)) throw new Error("Invalid OAuth store name");
    const oauthBaseUrl = OAuthAPI.getOAuthUrl({ storeName });
    const authorizeUrl =
      `${oauthBaseUrl}/authorize` +
      `?client_id=${encodeURIComponent(config.oauth.clientId!)}` +
      `&redirect_uri=${encodeURIComponent(getRedirectUri())}` +
      `&scope=${encodeURIComponent(config.oauth.scope)}` +
      `&state=${encodeURIComponent(state)}`;

    const response = NextResponse.redirect(authorizeUrl);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    console.error(
      JSON.stringify({
        event: "ikas_oauth_authorize",
        correlationId: errorId,
        stage: failureStage,
        outcome: "failure",
        reason: failureReason,
      }),
    );
    return failRedirect(failureReason, errorId, requestedStoreName);
  }
}
