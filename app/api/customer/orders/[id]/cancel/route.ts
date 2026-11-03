import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { parseBody, requireUser, rpcErrorResponse } from "@/lib/customer/api";
import { cancelOrderSchema, orderIdSchema } from "@/lib/orders/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Eligibility, ownership, stock and point restoration are handled by cancel_order.
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/customer/orders/[id]/cancel">,
) {
  try {
    const { id } = await ctx.params;
    if (!orderIdSchema.safeParse(id).success) {
      return errorResponse("Invalid order ID", 400);
    }

    const auth = await requireUser();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, cancelOrderSchema);
    if ("response" in body) return body.response;

    const { data, error } = await auth.supabase.rpc("cancel_order", {
      p_order_id: id,
      p_reason: body.data.reason ?? null,
      // Customers can never assert that items were physically returned.
      p_items_physically_returned: false,
    });

    if (error) {
      return rpcErrorResponse(error, "Cancel order", "Unable to cancel order");
    }

    return successResponse(data, "Order cancelled successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Cancel order API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
