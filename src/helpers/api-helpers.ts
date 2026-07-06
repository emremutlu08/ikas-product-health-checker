import { config } from "@/globals/config";

export function getRedirectUri(host: string) {
  const protocol = host.includes("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return `${protocol}://${host}/api/oauth/callback/ikas`;
}

export function requireOAuthConfig() {
  if (!config.oauth.clientId || !config.oauth.clientSecret) {
    throw new Error("NEXT_PUBLIC_CLIENT_ID and CLIENT_SECRET are required for ikas OAuth");
  }
}
