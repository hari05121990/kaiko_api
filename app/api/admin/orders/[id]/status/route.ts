import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { adminErrorResponse, firstRow, requireStaff } from "@/lib/admin/api";
import { findScopedOrder } from "@/lib/admin/orders";
import { idSchema, updateOrderStatusSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Requires Migration 008 (admin_update_order_status). The function locks the
// order, checks store access and the allowed transition, and writes
// order_status_history and admin_audit_logs. orders is never updated directly.
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/orders/[id]/status">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid order ID", 400);
    }

    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, updateOrderStatusSchema);
    if ("response" in body) return body.response;

    const { data: order, error: lookupError } = await findScopedOrder(auth, id);

    if (lookupError) {
      console.error("Order status lookup:", lookupError.code, lookupError.message);
      return errorResponse("Unable to update order status", 500);
    }

    if (!order) {
      return errorResponse("Order not found", 404);
    }

    const { data, error } = await auth.supabase.rpc("admin_update_order_status", {
      p_order_id: id,
      p_new_status: body.data.status,
      p_remarks: body.data.remarks || null,
    });

    if (error) {
      return adminErrorResponse(error, "Update order status", "Unable to update order status");
    }

    return successResponse(firstRow(data), "Order status updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Update order status API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
