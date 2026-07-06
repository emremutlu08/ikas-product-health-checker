import { config } from "@/globals/config";
import { getRedirectUri, requireOAuthConfig } from "@/helpers/api-helpers";
import { getSession } from "@/lib/session";
import { validateRequest } from "@/lib/validation";
import { OAuthAPI } from "@ikas/admin-api-client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const authorizeSchema = z.object({ storeName: z.string().min(1) });

export async function GET(request: NextRequest) {
  try {
    requireOAuthConfig();
    const url = new URL(request.url);
    const validation = validateRequest(authorizeSchema, { storeName: url.searchParams.get("storeName") });
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });

    const state = crypto.randomUUID();
    const session = await getSession();
    session.state = state;
    session.storeName = validation.data.storeName;
    await session.save();

    const oauthBaseUrl = OAuthAPI.getOAuthUrl({ storeName: validation.data.storeName });
    const authorizeUrl =
      `${oauthBaseUrl}/authorize` +
      `?client_id=${encodeURIComponent(config.oauth.clientId!)}` +
      `&redirect_uri=${encodeURIComponent(getRedirectUri(request.headers.get("host")!))}` +
      `&scope=${encodeURIComponent(config.oauth.scope)}` +
      `&state=${encodeURIComponent(state)}`;

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    console.error("ikas OAuth authorize error", error);
    return NextResponse.json({ error: "Authorization failed" }, { status: 500 });
  }
}
