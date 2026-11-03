import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  canAccessStore,
  pageRange,
  pagination,
  parseQuery,
  requireStaff,
  searchPattern,
} from "@/lib/admin/api";
import { ADMIN_ORDER_SUMMARY_COLUMNS } from "@/lib/admin/orders";
import { adminOrderListQuerySchema, toTimestampRange } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, adminOrderListQuerySchema);
    if ("response" in query) return query.response;

    const { page, limit, status, fulfilment_type, store_id, customer_id, q, from, to } =
      query.data;

    const range = toTimestampRange(from, to);
    if (range.error) return errorResponse(range.error, 400);

    if (store_id && !canAccessStore(auth, store_id)) {
      return errorResponse("You do not have access to this store", 403);
    }

    let ordersQuery = auth.supabase
      .from("orders")
      .select(ADMIN_ORDER_SUMMARY_COLUMNS, { count: "exact" });

    if (store_id) {
      ordersQuery = ordersQuery.eq("store_id", store_id);
    } else if (!auth.isGlobalAdmin) {
      ordersQuery = ordersQuery.in("store_id", auth.storeIds);
    }

    if (status) ordersQuery = ordersQuery.eq("order_status", status);
    if (fulfilment_type) ordersQuery = ordersQuery.eq("fulfilment_type", fulfilment_type);
    if (customer_id) ordersQuery = ordersQuery.eq("customer_id", customer_id);
    if (q) ordersQuery = ordersQuery.ilike("order_number", searchPattern(q));
    if (range.start) ordersQuery = ordersQuery.gte("created_at", range.start);
    if (range.end) ordersQuery = ordersQuery.lte("created_at", range.end);

    const [rangeFrom, rangeTo] = pageRange(page, limit);

    const { data, error, count } = await ordersQuery
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(rangeFrom, rangeTo);

    if (error) {
      console.error("Admin orders:", error.code, error.message);
      return errorResponse("Unable to retrieve orders", 500);
    }

    return successResponse(
      { orders: data ?? [], pagination: pagination(page, limit, count) },
      "Orders retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Admin orders API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
