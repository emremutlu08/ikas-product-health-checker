import { getCanonicalAppOrigin } from "@/helpers/api-helpers";
import { isInterestIntent, InterestStoreError, recordInterest } from "@/lib/interest/interest-store";
import { getSession, readInstallationSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = { "cache-control": "private, no-store" };

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

async function readIntent(request: Request) {
  try {
    const form = await request.formData();
    return form.get("intent");
  } catch {
    return undefined;
  }
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();

  try {
    // Tenant identity comes only from the sealed installation session; anything the
    // client sends in the body or query string is ignored.
    const installation = readInstallationSession(await getSession());
    if (!installation) return jsonResponse({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401);

    const canonicalOrigin = getCanonicalAppOrigin();
    if (request.headers.get("origin") !== canonicalOrigin) {
      return jsonResponse({ error: "IKAS_INTEREST_ORIGIN_INVALID" }, 403);
    }

    const intent = await readIntent(request);
    if (!isInterestIntent(intent)) return jsonResponse({ error: "IKAS_INTEREST_INTENT_INVALID" }, 400);

    // Resolved before recording so a misconfigured origin cannot report failure for a
    // signal that was already durably stored.
    const location = new URL("/", canonicalOrigin);
    location.searchParams.set("interest", "recorded");

    // Recording is idempotent per authorizedAppId + intent, so a repeat submission is
    // still a success for the merchant.
    await recordInterest({
      authorizedAppId: installation.authorizedAppId,
      merchantId: installation.merchantId,
      intent,
      createdAt: Date.now(),
    });

    return new Response(null, {
      status: 303,
      headers: { ...PRIVATE_NO_STORE_HEADERS, location: location.toString() },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ikas_interest_record",
        correlationId,
        outcome: "failure",
        reason: error instanceof InterestStoreError ? error.code : "unexpected",
      }),
    );
    return jsonResponse({ error: "IKAS_INTEREST_BACKEND_UNAVAILABLE" }, 503);
  }
}
