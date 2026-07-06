import { config } from "@/globals/config";
import { OAuthAPI } from "@ikas/admin-api-client";
import { promises as fs } from "fs";
import path from "path";

type StoredIkasToken = {
  authorizedAppId: string;
  merchantId?: string;
  storeName?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
};

const TOKEN_STORE_PATH = path.join(process.cwd(), ".ikas-runtime-tokens.json");

async function writeStore(store: Record<string, StoredIkasToken>) {
  await fs.writeFile(TOKEN_STORE_PATH, JSON.stringify(store, null, 2));
}

async function readStore(): Promise<Record<string, StoredIkasToken>> {
  try {
    return JSON.parse(await fs.readFile(TOKEN_STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function refreshStoredToken(token: StoredIkasToken): Promise<StoredIkasToken | undefined> {
  if (!token.refreshToken || !config.oauth.clientId || !config.oauth.clientSecret) return undefined;

  try {
    const response = await OAuthAPI.refreshToken(
      {
        refresh_token: token.refreshToken,
        client_id: config.oauth.clientId,
        client_secret: config.oauth.clientSecret,
      },
      { storeName: token.storeName || "api" },
    );

    if (!response.data?.access_token) return undefined;

    return {
      ...token,
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token || token.refreshToken,
      tokenType: response.data.token_type || token.tokenType,
      expiresAt: Date.now() + response.data.expires_in * 1000,
    };
  } catch {
    return undefined;
  }
}

export async function saveIkasToken(token: StoredIkasToken) {
  const store = await readStore();
  store[token.authorizedAppId] = token;
  await writeStore(store);
}

export async function invalidateIkasToken(authorizedAppId?: string | null) {
  if (!authorizedAppId) return;
  const store = await readStore();
  delete store[authorizedAppId];
  await writeStore(store);
}

export async function getIkasToken(authorizedAppId?: string | null) {
  if (!authorizedAppId) return undefined;
  const store = await readStore();
  const token = store[authorizedAppId];
  if (!token) return undefined;

  // Refresh five minutes early to avoid LOGIN_REQUIRED during normal dashboard viewing.
  if (token.expiresAt && token.expiresAt <= Date.now() + 5 * 60_000) {
    const refreshed = await refreshStoredToken(token);
    if (refreshed) {
      store[authorizedAppId] = refreshed;
      await writeStore(store);
      return refreshed;
    }

    delete store[authorizedAppId];
    await writeStore(store);
    return undefined;
  }

  return token;
}
