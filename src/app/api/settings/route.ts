import { getCanonicalAppOrigin } from "@/helpers/api-helpers";
import { IkasAuthenticationError } from "@/lib/ikas/errors";
import { isDailySummaryEmailConfigured } from "@/lib/monitoring/email-summary";
import { resolveVerifiedRecipient } from "@/lib/monitoring/verified-recipient";
import {
  readMonitoringSettings,
  SettingsAccessError,
  SettingsValidationError,
  updateMonitoringSettings,
} from "@/lib/settings/settings-service";
import { MonitoringSettingsStoreError } from "@/lib/settings/settings-store";
import { getSession, readInstallationSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = { "cache-control": "private, no-store" };

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

function prefersHtml(request: Request) {
  return request.headers.get("accept")?.includes("text/html") ?? false;
}

/** Errors that are read boundaries (auth, entitlement, backend) map the same way on GET and POST. */
function describeFailure(error: unknown): { status: number; code: string } {
  if (error instanceof SettingsAccessError) return { status: 403, code: error.code };
  if (error instanceof SettingsValidationError) return { status: 400, code: error.code };
  if (error instanceof IkasAuthenticationError) return { status: 401, code: "IKAS_LIVE_AUTH_REQUIRED" };
  if (error instanceof MonitoringSettingsStoreError) {
    return { status: 503, code: "IKAS_SETTINGS_BACKEND_UNAVAILABLE" };
  }
  return { status: 500, code: "IKAS_SETTINGS_FAILED" };
}

export async function GET() {
  const correlationId = crypto.randomUUID();
  try {
    const installation = readInstallationSession(await getSession());
    if (!installation) return jsonResponse({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401);

    const view = await readMonitoringSettings(installation);
    return jsonResponse(view, 200);
  } catch (error) {
    const { status, code } = describeFailure(error);
    console.error(
      JSON.stringify({ event: "ikas_settings_read", correlationId, outcome: "failure", reason: code }),
    );
    return jsonResponse({ error: code }, status);
  }
}

/** Native form fields arrive as strings; the checkbox is present only when checked. */
function readSettingsForm(form: FormData) {
  const rawThreshold = form.get("lowStockThreshold");
  const rawEmail = form.get("dailyEmailEnabled");
  const lowStockThreshold =
    typeof rawThreshold === "string" && rawThreshold.trim() !== "" ? Number(rawThreshold) : Number.NaN;
  return {
    lowStockThreshold,
    dailyEmailEnabled: rawEmail === "on" || rawEmail === "true",
  };
}

function settingsRedirect(
  canonicalOrigin: string,
  status: "saved" | "invalid" | "unavailable" | "error",
) {
  const location = new URL("/settings", canonicalOrigin);
  location.searchParams.set("status", status);
  return new Response(null, {
    status: 303,
    headers: { ...PRIVATE_NO_STORE_HEADERS, location: location.toString() },
  });
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  let canonicalOrigin: string | undefined;

  try {
    canonicalOrigin = getCanonicalAppOrigin();
    if (request.headers.get("origin") !== canonicalOrigin) {
      return jsonResponse({ error: "IKAS_SETTINGS_ORIGIN_INVALID" }, 403);
    }

    // Tenant identity comes only from the sealed installation session. Body and query are never
    // consulted to select an installation.
    const installation = readInstallationSession(await getSession());
    if (!installation) {
      return prefersHtml(request)
        ? settingsRedirect(canonicalOrigin, "error")
        : jsonResponse({ error: "IKAS_LIVE_AUTH_REQUIRED" }, 401);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonResponse({ error: "IKAS_SETTINGS_INVALID" }, 400);
    }

    // Only the two settings fields are read, so a tenant selector in the same body is ignored.
    const settings = readSettingsForm(form);
    const currentEmailEnabled = settings.dailyEmailEnabled
      ? (await readMonitoringSettings(installation)).settings.dailyEmailEnabled
      : false;
    if (settings.dailyEmailEnabled && !currentEmailEnabled) {
      let emailReady =
        process.env.IKAS_MONITORING_SCHEDULER_ENABLED?.trim() === "true" &&
        isDailySummaryEmailConfigured();
      try {
        emailReady = emailReady && Boolean(resolveVerifiedRecipient(installation));
      } catch {
        emailReady = false;
      }
      if (!emailReady) {
        return prefersHtml(request)
          ? settingsRedirect(canonicalOrigin, "unavailable")
          : jsonResponse({ error: "IKAS_MONITORING_EMAIL_UNAVAILABLE" }, 409);
      }
    }
    await updateMonitoringSettings(installation, settings);

    return prefersHtml(request)
      ? settingsRedirect(canonicalOrigin, "saved")
      : jsonResponse({ tier: "pro" }, 200);
  } catch (error) {
    const { status, code } = describeFailure(error);
    console.error(
      JSON.stringify({ event: "ikas_settings_write", correlationId, outcome: "failure", reason: code }),
    );

    // Browser form failures return to the settings UI instead of stranding the merchant on JSON.
    if (canonicalOrigin && prefersHtml(request)) {
      return settingsRedirect(
        canonicalOrigin,
        error instanceof SettingsValidationError ? "invalid" : "error",
      );
    }
    return jsonResponse({ error: code }, status);
  }
}
