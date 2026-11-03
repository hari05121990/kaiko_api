import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/admin/api";
import { ADMIN_ORDER_DETAIL_COLUMNS, findScopedOrder } from "@/lib/admin/orders";
import { idSchema } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/admin/orders/[id]">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid order ID", 400);
    }

    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const { data, error } = await findScopedOrder(auth, id, ADMIN_ORDER_DETAIL_COLUMNS);

    if (error) {
      console.error("Admin order details:", error.code, error.message);
      return errorResponse("Unable to retrieve order", 500);
    }

    if (!data) {
      return errorResponse("Order not found", 404);
    }

    return successResponse(data, "Order retrieved successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Admin order details API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
