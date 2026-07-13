import { getProductHealthReport } from "@/lib/ikas/report-service";
import { IkasAuthenticationError, IkasUpstreamError } from "@/lib/ikas/errors";
import { IkasTokenRefreshError, TokenStoreError } from "@/lib/ikas/token-store";
import { getSession, readInstallationSession } from "@/lib/session";

export const dynamic = "force-dynamic";
const PRIVATE_NO_STORE_HEADERS = { "cache-control": "private, no-store" };

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function GET(request: Request) {
  void request;
  try {
    const installation = readInstallationSession(await getSession());
    if (!installation) return jsonResponse({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401);

    const result = await getProductHealthReport(new Date(), installation);
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof IkasAuthenticationError) {
      return jsonResponse({ error: error.code }, 401);
    }
    if (error instanceof TokenStoreError || error instanceof IkasTokenRefreshError) {
      return jsonResponse({ error: "IKAS_TOKEN_BACKEND_UNAVAILABLE" }, 503);
    }
    if (error instanceof IkasUpstreamError) {
      return jsonResponse({ error: error.code }, 502);
    }
    return jsonResponse({ error: "IKAS_REPORT_FAILED" }, 500);
  }
}
