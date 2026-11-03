import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { adminErrorResponse, requireGlobalAdmin } from "@/lib/admin/api";
import { PRODUCT_IMAGE_COLUMNS } from "@/lib/admin/catalog";
import { idSchema } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Removes the image record only; the stored file is not deleted.
export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext<"/api/admin/products/[id]/images/[imageId]">,
) {
  try {
    const { id, imageId } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid product ID", 400);
    }
    if (!idSchema.safeParse(imageId).success) {
      return errorResponse("Invalid image ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const { data, error } = await auth.supabase
      .from("product_images")
      .delete()
      .eq("id", imageId)
      .eq("product_id", id)
      .select(PRODUCT_IMAGE_COLUMNS)
      .maybeSingle();

    if (error) {
      return adminErrorResponse(error, "Delete product image", "Unable to delete product image");
    }

    if (!data) {
      return errorResponse("Product image not found", 404);
    }

    return successResponse(data, "Product image deleted successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Delete product image API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
