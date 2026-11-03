import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { canAccessStore, countRows, parseQuery, requireStaff } from "@/lib/admin/api";
import {
  FULFILMENT_TYPES,
  ORDER_STATUSES,
  reportQuerySchema,
  toTimestampRange,
} from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

// Order counts by status and fulfilment type for a date range (default: the
// last 30 days). Each figure is a HEAD count query on indexed columns.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, reportQuerySchema);
    if ("response" in query) return query.response;

    const { store_id } = query.data;

    const range = toTimestampRange(query.data.from, query.data.to);
    if (range.error) return errorResponse(range.error, 400);

    const end = range.end ?? new Date().toISOString();
    const start =
      range.start ?? new Date(Date.parse(end) - DEFAULT_DAYS * DAY_MS).toISOString();

    if (Date.parse(end) - Date.parse(start) > MAX_DAYS * DAY_MS) {
      return errorResponse(`Date range must not exceed ${MAX_DAYS} days`, 400);
    }

    if (store_id && !canAccessStore(auth, store_id)) {
      return errorResponse("You do not have access to this store", 403);
    }

    const scopedStoreIds = store_id ? [store_id] : auth.isGlobalAdmin ? null : auth.storeIds;

    const orders = () => {
      const q = auth.supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .gte("created_at", start)
        .lte("created_at", end);
      return scopedStoreIds ? q.in("store_id", scopedStoreIds) : q;
    };

    const [statusCounts, fulfilmentCounts] = await Promise.all([
      Promise.all(
        ORDER_STATUSES.map((status) => countRows(orders().eq("order_status", status))),
      ),
      Promise.all(
        FULFILMENT_TYPES.map((type) => countRows(orders().eq("fulfilment_type", type))),
      ),
    ]);

    return successResponse(
      {
        period: { from: start, to: end },
        scope: { store_ids: scopedStoreIds ?? "ALL" },
        total_orders: statusCounts.reduce((sum, value) => sum + value, 0),
        by_status: Object.fromEntries(
          ORDER_STATUSES.map((status, index) => [status, statusCounts[index]]),
        ),
        by_fulfilment_type: Object.fromEntries(
          FULFILMENT_TYPES.map((type, index) => [type, fulfilmentCounts[index]]),
        ),
      },
      "Order report retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Order report API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
