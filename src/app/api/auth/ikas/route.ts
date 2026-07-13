import { type NextRequest } from "next/server";
import { handleIkasLaunch } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleIkasLaunch(request);
}
