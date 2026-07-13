import { config } from "@/globals/config";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_ORIGIN_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

export type CanonicalAppOriginOptions = {
  deployUrl?: string;
  environment?: string;
};

function decodeOriginInput(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("NEXT_PUBLIC_DEPLOY_URL must be a valid canonical origin");
  }
}

export function getCanonicalAppOrigin({
  deployUrl = config.deployUrl,
  environment = process.env.NODE_ENV,
}: CanonicalAppOriginOptions = {}) {
  if (!deployUrl || deployUrl !== deployUrl.trim()) {
    throw new Error("NEXT_PUBLIC_DEPLOY_URL must be a valid canonical origin");
  }

  const decodedInput = decodeOriginInput(deployUrl);
  if (
    deployUrl.includes("%") ||
    FORBIDDEN_ORIGIN_CHARACTERS.test(deployUrl) ||
    FORBIDDEN_ORIGIN_CHARACTERS.test(decodedInput) ||
    decodedInput.includes("@")
  ) {
    throw new Error("NEXT_PUBLIC_DEPLOY_URL must not contain userinfo or unsafe characters");
  }

  let url: URL;
  try {
    url = new URL(deployUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_DEPLOY_URL must be a valid canonical origin");
  }

  if (
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("NEXT_PUBLIC_DEPLOY_URL must contain only an origin");
  }

  if (deployUrl !== url.origin && deployUrl !== `${url.origin}/`) {
    throw new Error("NEXT_PUBLIC_DEPLOY_URL must be canonical");
  }

  const isNonProductionLoopback =
    environment !== "production" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isNonProductionLoopback)) {
    throw new Error("NEXT_PUBLIC_DEPLOY_URL must use HTTPS outside local development");
  }

  return url.origin;
}

export function getRedirectUri(options?: CanonicalAppOriginOptions) {
  return `${getCanonicalAppOrigin(options)}/api/oauth/callback/ikas`;
}

export function requireOAuthConfig() {
  if (!config.oauth.clientId || !config.oauth.clientSecret) {
    throw new Error("NEXT_PUBLIC_CLIENT_ID and CLIENT_SECRET are required for ikas OAuth");
  }
}
