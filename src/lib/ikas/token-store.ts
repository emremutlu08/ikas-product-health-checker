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

async function readStore(): Promise<Record<string, StoredIkasToken>> {
  try {
    return JSON.parse(await fs.readFile(TOKEN_STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export async function saveIkasToken(token: StoredIkasToken) {
  const store = await readStore();
  store[token.authorizedAppId] = token;
  await fs.writeFile(TOKEN_STORE_PATH, JSON.stringify(store, null, 2));
}

export async function getIkasToken(authorizedAppId?: string | null) {
  if (!authorizedAppId) return undefined;
  const store = await readStore();
  return store[authorizedAppId];
}
