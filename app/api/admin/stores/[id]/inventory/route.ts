import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  canAccessStore,
  pageRange,
  pagination,
  parseQuery,
  requireStaff,
} from "@/lib/admin/api";
import { idSchema, inventoryQuerySchema } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/stores/[id]/inventory">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid store ID", 400);
    }

    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    if (!canAccessStore(auth, id)) {
      return errorResponse("You do not have access to this store", 403);
    }

    const query = parseQuery(request, inventoryQuerySchema);
    if ("response" in query) return query.response;

    const { data: store, error: storeError } = await auth.supabase
      .from("stores")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (storeError) {
      console.error("Inventory store lookup:", storeError.code, storeError.message);
      return errorResponse("Unable to retrieve inventory", 500);
    }

    if (!store) {
      return errorResponse("Store not found", 404);
    }

    const { page, limit, is_available, low_stock } = query.data;

    let inventoryQuery = auth.supabase
      .from("store_products")
      .select(
        `
          id,
          store_id,
          product_id,
          stock_quantity,
          is_available,
          updated_at,
          product:products ( id, name, sku, price, status )
        `,
        { count: "exact" },
      )
      .eq("store_id", id);

    if (is_available !== undefined) {
      inventoryQuery = inventoryQuery.eq("is_available", is_available);
    }
    if (low_stock !== undefined) {
      inventoryQuery = inventoryQuery.lte("stock_quantity", low_stock);
    }

    const [from, to] = pageRange(page, limit);

    const { data, error, count } = await inventoryQuery
      .order("stock_quantity", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      console.error("Store inventory:", error.code, error.message);
      return errorResponse("Unable to retrieve inventory", 500);
    }

    return successResponse(
      { inventory: data ?? [], pagination: pagination(page, limit, count) },
      "Inventory retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Store inventory API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
