import { config } from "@/globals/config";
import { getRedirectUri, getRequestBaseUrl, requireOAuthConfig } from "@/helpers/api-helpers";
import { getSession } from "@/lib/session";
import { saveIkasToken } from "@/lib/ikas/token-store";
import { validateRequest } from "@/lib/validation";
import { OAuthAPI } from "@ikas/admin-api-client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
  storeName: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    requireOAuthConfig();
    const url = new URL(request.url);
    const validation = validateRequest(callbackSchema, {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state") ?? undefined,
      storeName: url.searchParams.get("storeName") ?? undefined,
    });
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });

    const session = await getSession();
    if (validation.data.state && session.state && validation.data.state !== session.state) {
      return NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
    }

    const tokenResponse = await OAuthAPI.getTokenWithAuthorizationCode(
      {
        code: validation.data.code,
        client_id: config.oauth.clientId!,
        client_secret: config.oauth.clientSecret!,
        redirect_uri: getRedirectUri(request.headers.get("host")!),
      },
      { storeName: validation.data.storeName || session.storeName || "api" },
    );

    if (!tokenResponse.data?.access_token) {
      return NextResponse.json({ error: "Failed to retrieve ikas access token" }, { status: 500 });
    }


    const contextResponse = await fetch(config.graphApiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenResponse.data.access_token}`,
      },
      body: JSON.stringify({
        query: `query getIkasAppContext { getMerchant { id storeName } getAuthorizedApp { id } }`,
      }),
      cache: "no-store",
    });

    const contextPayload = await contextResponse.json();
    const authorizedAppId = contextPayload?.data?.getAuthorizedApp?.id;
    const merchantId = contextPayload?.data?.getMerchant?.id;
    const storeName = contextPayload?.data?.getMerchant?.storeName || validation.data.storeName || session.storeName;

    if (authorizedAppId) {
      await saveIkasToken({
        authorizedAppId,
        merchantId,
        storeName,
        accessToken: tokenResponse.data.access_token,
        refreshToken: tokenResponse.data.refresh_token,
        tokenType: tokenResponse.data.token_type,
        expiresAt: Date.now() + tokenResponse.data.expires_in * 1000,
      });
    }

    session.accessToken = tokenResponse.data.access_token;
    session.refreshToken = tokenResponse.data.refresh_token;
    session.tokenType = tokenResponse.data.token_type;
    session.expiresAt = Date.now() + tokenResponse.data.expires_in * 1000;
    await session.save();

    return NextResponse.redirect(`${getRequestBaseUrl(request)}/?source=ikas`);
  } catch (error) {
    console.error("ikas OAuth callback error", error);
    return NextResponse.redirect(`${getRequestBaseUrl(request)}/authorize-store?status=fail`);
  }
}
