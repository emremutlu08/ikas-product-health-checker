import { createHash, timingSafeEqual } from "node:crypto";
import { runDailyMonitoring } from "@/lib/monitoring/daily-monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE_HEADERS = { "cache-control": "private, no-store" };

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(request: Request, secret: string) {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return timingSafeEqual(digest(header), digest(expected));
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 32 || secret.length > 512) {
    return json({ error: "IKAS_MONITORING_UNAVAILABLE" }, 503);
  }
  if (!authorized(request, secret)) {
    return json({ error: "IKAS_MONITORING_UNAUTHORIZED" }, 401);
  }
  if (process.env.IKAS_MONITORING_SCHEDULER_ENABLED?.trim() !== "true") {
    return json({ error: "IKAS_MONITORING_UNAVAILABLE" }, 503);
  }

  const correlationId = crypto.randomUUID();
  try {
    const result = await runDailyMonitoring();
    console.info(JSON.stringify({ event: "ikas_daily_monitoring", correlationId, outcome: "completed", ...result }));
    return json(result, 200);
  } catch {
    console.error(
      JSON.stringify({ event: "ikas_daily_monitoring", correlationId, outcome: "failure", reason: "internal" }),
    );
    return json({ error: "IKAS_MONITORING_FAILED" }, 500);
  }
}
