import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { adminErrorResponse, firstRow, requireGlobalAdmin } from "@/lib/admin/api";
import { customerStatusSchema, idSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Requires Migration 008 (admin_set_customer_status). The status change and its
// audit log row are written by the database function.
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/customers/[id]/status">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid customer ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, customerStatusSchema);
    if ("response" in body) return body.response;

    const { data, error } = await auth.supabase.rpc("admin_set_customer_status", {
      p_customer_id: id,
      p_status: body.data.status,
      p_reason: body.data.reason,
    });

    if (error) {
      return adminErrorResponse(
        error,
        "Set customer status",
        "Unable to update customer status",
      );
    }

    return successResponse(firstRow(data), "Customer status updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Set customer status API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
