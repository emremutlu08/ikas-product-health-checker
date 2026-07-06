import { config } from "@/globals/config";
import { TOKEN_COOKIE } from "@/globals/constants";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";

export type SessionData = {
  state?: string;
  storeName?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
};

function cookiePassword() {
  const password = config.cookiePassword;
  if (!password || password.length < 32) {
    throw new Error("SECRET_COOKIE_PASSWORD must be at least 32 characters for ikas OAuth session storage");
  }
  return password;
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), {
    password: cookiePassword(),
    cookieName: TOKEN_COOKIE,
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  });
}
