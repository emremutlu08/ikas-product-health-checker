import { getProductHealthReport } from "@/lib/ikas/report-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const authorizedAppId = url.searchParams.get("authorizedAppId");
    const result = await getProductHealthReport(new Date(), authorizedAppId);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown report error";
    return Response.json({ error: message }, { status: 500 });
  }
}
