import { getProductHealthReportCsv } from "@/lib/ikas/report-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const authorizedAppId = url.searchParams.get("authorizedAppId");
    const csv = await getProductHealthReportCsv(authorizedAppId);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="ikas-product-health-report.csv"',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CSV report error";
    const status = message.includes("IKAS_LIVE_AUTH_REQUIRED") || message.includes("LOGIN_REQUIRED") ? 401 : 500;
    return Response.json({ error: message }, { status });
  }
}
