import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { canAccessStore, countRows, parseQuery, requireStaff } from "@/lib/admin/api";
import { dashboardQuerySchema, ORDER_STATUSES } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// India Standard Time has a fixed +05:30 offset (no DST).
const IST_OFFSET_MS = 330 * 60 * 1000;

function startOfTodayIst() {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  nowIst.setUTCHours(0, 0, 0, 0);
  return new Date(nowIst.getTime() - IST_OFFSET_MS).toISOString();
}

// Counts only: every figure is a HEAD count query, so no rows are loaded.
// Revenue and points totals need a database aggregation function (not available).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, dashboardQuerySchema);
    if ("response" in query) return query.response;

    const { store_id, low_stock } = query.data;

    if (store_id && !canAccessStore(auth, store_id)) {
      return errorResponse("You do not have access to this store", 403);
    }

    const scopedStoreIds = store_id ? [store_id] : auth.isGlobalAdmin ? null : auth.storeIds;

    const orders = () => {
      const q = auth.supabase.from("orders").select("id", { count: "exact", head: true });
      return scopedStoreIds ? q.in("store_id", scopedStoreIds) : q;
    };

    const todayStart = startOfTodayIst();

    const lowStockQuery = auth.supabase
      .from("store_products")
      .select("id", { count: "exact", head: true })
      .eq("is_available", true)
      .lte("stock_quantity", low_stock);

    const [statusCounts, ordersToday, lowStockItems] = await Promise.all([
      Promise.all(
        ORDER_STATUSES.map((status) => countRows(orders().eq("order_status", status))),
      ),
      countRows(orders().gte("created_at", todayStart)),
      countRows(
        scopedStoreIds ? lowStockQuery.in("store_id", scopedStoreIds) : lowStockQuery,
      ),
    ]);

    const ordersByStatus = Object.fromEntries(
      ORDER_STATUSES.map((status, index) => [status, statusCounts[index]]),
    );

    // Catalog-wide figures are only meaningful (and visible) to global admins.
    const catalog = auth.isGlobalAdmin
      ? await Promise.all([
          countRows(
            auth.supabase
              .from("products")
              .select("id", { count: "exact", head: true })
              .eq("status", "ACTIVE"),
          ),
          countRows(
            auth.supabase
              .from("categories")
              .select("id", { count: "exact", head: true })
              .eq("status", "ACTIVE"),
          ),
          countRows(
            auth.supabase
              .from("stores")
              .select("id", { count: "exact", head: true })
              .eq("status", "ACTIVE"),
          ),
          countRows(
            auth.supabase
              .from("user_roles")
              .select("id", { count: "exact", head: true })
              .eq("role", "CUSTOMER"),
          ),
        ]).then(([activeProducts, activeCategories, activeStores, customers]) => ({
          active_products: activeProducts,
          active_categories: activeCategories,
          active_stores: activeStores,
          customers,
        }))
      : null;

    return successResponse(
      {
        scope: { store_ids: scopedStoreIds ?? "ALL" },
        orders: {
          total: statusCounts.reduce((sum, value) => sum + value, 0),
          today: ordersToday,
          today_starts_at: todayStart,
          by_status: ordersByStatus,
        },
        inventory: { low_stock_threshold: low_stock, low_stock_items: lowStockItems },
        catalog,
      },
      "Dashboard retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Dashboard API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
