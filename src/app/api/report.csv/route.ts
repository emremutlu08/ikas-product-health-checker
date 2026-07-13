import { getProductHealthReportCsv } from "@/lib/ikas/report-service";
import { IkasAuthenticationError, IkasUpstreamError } from "@/lib/ikas/errors";
import { IkasTokenRefreshError, TokenStoreError } from "@/lib/ikas/token-store";
import { getSession, readInstallationSession } from "@/lib/session";

export const dynamic = "force-dynamic";
const PRIVATE_NO_STORE_HEADERS = { "cache-control": "private, no-store" };

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function GET(request: Request) {
  void request;
  try {
    const installation = readInstallationSession(await getSession());
    if (!installation) return jsonResponse({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401);

    const csv = await getProductHealthReportCsv(installation);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="ikas-product-health-report.csv"',
        ...PRIVATE_NO_STORE_HEADERS,
      },
    });
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
