import { getCanonicalAppOrigin } from "@/helpers/api-helpers";
import { IkasAuthenticationError, IkasUpstreamError } from "@/lib/ikas/errors";
import { IkasTokenRefreshError, TokenStoreError } from "@/lib/ikas/token-store";
import { runManualScan, ScanBusyError } from "@/lib/scans/scan-service";
import { SnapshotStoreError, toSafeSnapshot } from "@/lib/scans/snapshot-store";
import { getSession, readInstallationSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = { "cache-control": "private, no-store" };

type ScanOutcome = "completed" | "busy" | "limit" | "failed";

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

function redirectResponse(canonicalOrigin: string, outcome: ScanOutcome) {
  const location = new URL("/", canonicalOrigin);
  location.searchParams.set("scan", outcome);
  return new Response(null, {
    status: 303,
    headers: { ...PRIVATE_NO_STORE_HEADERS, location: location.toString() },
  });
}

/** A browser form submission wants the dashboard back, not a JSON body. */
function prefersHtml(request: Request) {
  return request.headers.get("accept")?.includes("text/html") ?? false;
}

function describeFailure(error: unknown): { status: number; code: string; outcome: ScanOutcome } {
  if (error instanceof ScanBusyError) {
    return { status: 409, code: error.code, outcome: "busy" };
  }
  if (error instanceof IkasAuthenticationError) {
    return { status: 401, code: error.code, outcome: "failed" };
  }
  if (error instanceof IkasUpstreamError) {
    return {
      status: 502,
      code: error.code,
      outcome: error.code === "IKAS_UPSTREAM_SCAN_LIMIT_EXCEEDED" ? "limit" : "failed",
    };
  }
  if (error instanceof TokenStoreError || error instanceof IkasTokenRefreshError) {
    return { status: 503, code: "IKAS_TOKEN_BACKEND_UNAVAILABLE", outcome: "failed" };
  }
  if (error instanceof SnapshotStoreError) {
    return { status: 503, code: "IKAS_SNAPSHOT_BACKEND_UNAVAILABLE", outcome: "failed" };
  }
  // Anything unrecognised is reported as a generic failure; raw upstream text never
  // reaches the merchant or the network.
  return { status: 500, code: "IKAS_SCAN_FAILED", outcome: "failed" };
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  let canonicalOrigin: string | undefined;

  try {
    // Tenant identity comes only from the sealed installation session. Query strings,
    // headers, and request bodies are never consulted to select an installation.
    const installation = readInstallationSession(await getSession());
    if (!installation) return jsonResponse({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401);

    canonicalOrigin = getCanonicalAppOrigin();
    if (request.headers.get("origin") !== canonicalOrigin) {
      return jsonResponse({ error: "IKAS_SCAN_ORIGIN_INVALID" }, 403);
    }

    const snapshot = await runManualScan(installation);

    return prefersHtml(request)
      ? redirectResponse(canonicalOrigin, "completed")
      : jsonResponse(toSafeSnapshot(snapshot), 200);
  } catch (error) {
    const { status, code, outcome } = describeFailure(error);

    console.error(
      JSON.stringify({
        event: "ikas_manual_scan",
        correlationId,
        outcome: "failure",
        reason: code,
      }),
    );

    // A failed scan leaves the previous successful snapshot untouched and readable, so
    // the merchant returns to a visibly stale — never a wrong or partial — report.
    if (canonicalOrigin && prefersHtml(request)) {
      return redirectResponse(canonicalOrigin, outcome);
    }
    return jsonResponse({ error: code }, status);
  }
}
