import {
  getProductHealthHistory,
  HistoryAccessError,
} from "@/lib/billing/history-service";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import { SnapshotStoreError } from "@/lib/scans/snapshot-store";
import { getSession, readInstallationSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = { "cache-control": "private, no-store" };

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

function describeFailure(error: unknown) {
  if (error instanceof HistoryAccessError) {
    return { status: 403, code: error.code };
  }
  if (error instanceof IkasAuthenticationError) {
    return { status: 401, code: "IKAS_LIVE_AUTH_REQUIRED" };
  }
  if (error instanceof SnapshotStoreError) {
    return { status: 503, code: "IKAS_SNAPSHOT_BACKEND_UNAVAILABLE" };
  }
  return { status: 500, code: "IKAS_HISTORY_FAILED" };
}

export async function GET() {
  const correlationId = crypto.randomUUID();

  try {
    const installation = readInstallationSession(await getSession());
    if (!installation) return jsonResponse({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401);

    const history = await getProductHealthHistory(installation);
    return jsonResponse(history, 200);
  } catch (error) {
    const { status, code } = describeFailure(error);
    console.error(
      JSON.stringify({
        event: "ikas_history_read",
        correlationId,
        outcome: "failure",
        reason: code,
      }),
    );
    return jsonResponse({ error: code }, status);
  }
}
