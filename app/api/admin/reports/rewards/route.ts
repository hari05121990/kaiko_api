import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { parseQuery, requireGlobalAdmin } from "@/lib/admin/api";
import { reportQuerySchema, toTimestampRange } from "@/lib/admin/schemas";
import { errorResponse } from "@/lib/utils/api-response";

// BLOCKED: points issued/redeemed/reversed need SUM(points) grouped by
// transaction type in the database. There is no reporting RPC and PostgREST
// aggregates are disabled, and summing in Next.js would mean loading the whole
// ledger for the range. The route authorises and validates the request, then
// reports the missing dependency.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, reportQuerySchema);
    if ("response" in query) return query.response;

    const range = toTimestampRange(query.data.from, query.data.to);
    if (range.error) return errorResponse(range.error, 400);

    return errorResponse(
      "Reward points report is not available yet: it requires a database reporting function for points aggregation",
      501,
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Rewards report API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
