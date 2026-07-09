import { config } from "@/globals/config";
import { getRedirectUri, requireOAuthConfig } from "@/helpers/api-helpers";
import { getSession } from "@/lib/session";
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

function failRedirect(request: NextRequest, storeName?: string | null) {
  const failUrl = new URL("/authorize-store", request.url);
  failUrl.searchParams.set("status", "fail");
  const normalizedStoreName = normalizeStoreNameInput(storeName);
  if (normalizedStoreName) failUrl.searchParams.set("storeName", normalizedStoreName);
  return NextResponse.redirect(failUrl);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const requestedStoreName = url.searchParams.get("storeName");

  try {
    requireOAuthConfig();
    const validation = validateRequest(authorizeSchema, { storeName: requestedStoreName });
    if (!validation.success) return failRedirect(request, requestedStoreName);

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
    return failRedirect(request, requestedStoreName);
  }
}
