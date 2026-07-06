import { getProductHealthReport } from "@/lib/ikas/report-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getProductHealthReport();
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown report error";
    return Response.json({ error: message }, { status: 500 });
  }
}
