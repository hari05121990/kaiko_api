import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/admin/api";
import { findScopedOrder } from "@/lib/admin/orders";
import { idSchema } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/admin/orders/[id]/history">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid order ID", 400);
    }

    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const { data: order, error: lookupError } = await findScopedOrder(auth, id);

    if (lookupError) {
      console.error("Order history lookup:", lookupError.code, lookupError.message);
      return errorResponse("Unable to retrieve order history", 500);
    }

    if (!order) {
      return errorResponse("Order not found", 404);
    }

    const { data, error } = await auth.supabase
      .from("order_status_history")
      .select("id, old_status, new_status, remarks, changed_by, created_at")
      .eq("order_id", id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Order history:", error.code, error.message);
      return errorResponse("Unable to retrieve order history", 500);
    }

    return successResponse(data ?? [], "Order history retrieved successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Order history API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
