import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  canAccessStore,
  pageRange,
  pagination,
  parseQuery,
  requireStaff,
} from "@/lib/admin/api";
import { inventoryTransactionQuerySchema, toTimestampRange } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// inventory_transactions RLS limits rows to stores the caller can access; the
// explicit store filter below keeps responses scoped the same way at the API layer.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, inventoryTransactionQuerySchema);
    if ("response" in query) return query.response;

    const { page, limit, store_id, product_id, transaction_type, from, to } = query.data;

    const range = toTimestampRange(from, to);
    if (range.error) return errorResponse(range.error, 400);

    if (store_id && !canAccessStore(auth, store_id)) {
      return errorResponse("You do not have access to this store", 403);
    }

    let transactionsQuery = auth.supabase
      .from("inventory_transactions")
      .select(
        `
          id,
          transaction_type,
          quantity_change,
          reference_type,
          reference_id,
          description,
          created_by,
          created_at,
          store_product:store_products!inner (
            id,
            store_id,
            product_id,
            product:products ( id, name, sku )
          )
        `,
        { count: "exact" },
      );

    if (store_id) {
      transactionsQuery = transactionsQuery.eq("store_product.store_id", store_id);
    } else if (!auth.isGlobalAdmin) {
      transactionsQuery = transactionsQuery.in("store_product.store_id", auth.storeIds);
    }

    if (product_id) {
      transactionsQuery = transactionsQuery.eq("store_product.product_id", product_id);
    }
    if (transaction_type) {
      transactionsQuery = transactionsQuery.eq("transaction_type", transaction_type);
    }
    if (range.start) transactionsQuery = transactionsQuery.gte("created_at", range.start);
    if (range.end) transactionsQuery = transactionsQuery.lte("created_at", range.end);

    const [rangeFrom, rangeTo] = pageRange(page, limit);

    const { data, error, count } = await transactionsQuery
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(rangeFrom, rangeTo);

    if (error) {
      console.error("Inventory transactions:", error.code, error.message);
      return errorResponse("Unable to retrieve inventory transactions", 500);
    }

    return successResponse(
      { transactions: data ?? [], pagination: pagination(page, limit, count) },
      "Inventory transactions retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Inventory transactions API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
