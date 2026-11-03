import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { adminErrorResponse, requireGlobalAdmin } from "@/lib/admin/api";
import { ADMIN_PRODUCT_COLUMNS } from "@/lib/admin/catalog";
import { idSchema, updateProductSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/products/[id]">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid product ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, updateProductSchema);
    if ("response" in body) return body.response;

    const { data, error } = await auth.supabase
      .from("products")
      .update(body.data)
      .eq("id", id)
      .select(ADMIN_PRODUCT_COLUMNS)
      .maybeSingle();

    if (error) {
      return adminErrorResponse(error, "Update product", "Unable to update product");
    }

    if (!data) {
      return errorResponse("Product not found", 404);
    }

    return successResponse(data, "Product updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Update product API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
