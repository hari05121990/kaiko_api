import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { adminErrorResponse, requireGlobalAdmin } from "@/lib/admin/api";
import { ADMIN_PRODUCT_COLUMNS } from "@/lib/admin/catalog";
import { idSchema, productStatusSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// ACTIVE, INACTIVE or DRAFT. Non-ACTIVE products are hidden from customers by RLS.
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/products/[id]/status">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid product ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, productStatusSchema);
    if ("response" in body) return body.response;

    const { data, error } = await auth.supabase
      .from("products")
      .update({ status: body.data.status })
      .eq("id", id)
      .select(ADMIN_PRODUCT_COLUMNS)
      .maybeSingle();

    if (error) {
      return adminErrorResponse(error, "Product status", "Unable to update product status");
    }

    if (!data) {
      return errorResponse("Product not found", 404);
    }

    return successResponse(data, "Product status updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Product status API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
