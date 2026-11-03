import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { canAccessStore, parseQuery, requireStaff } from "@/lib/admin/api";
import { reportQuerySchema, toTimestampRange } from "@/lib/admin/schemas";
import { errorResponse } from "@/lib/utils/api-response";

// BLOCKED: sales totals need SUM(total_amount) grouped in the database.
// There is no reporting RPC and PostgREST aggregates are disabled, and summing
// in Next.js would mean loading every order row in the range. The route
// authorises and validates the request, then reports the missing dependency.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, reportQuerySchema);
    if ("response" in query) return query.response;

    const range = toTimestampRange(query.data.from, query.data.to);
    if (range.error) return errorResponse(range.error, 400);

    if (query.data.store_id && !canAccessStore(auth, query.data.store_id)) {
      return errorResponse("You do not have access to this store", 403);
    }

    return errorResponse(
      "Sales report is not available yet: it requires a database reporting function for sales aggregation",
      501,
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Sales report API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
