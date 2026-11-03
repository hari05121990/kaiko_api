import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { adminErrorResponse, requireGlobalAdmin } from "@/lib/admin/api";
import { PRODUCT_IMAGE_COLUMNS } from "@/lib/admin/catalog";
import { idSchema, productImageSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Registers an image that is already uploaded (storage path or https URL).
// File upload itself is not handled by this API.
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/products/[id]/images">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid product ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, productImageSchema);
    if ("response" in body) return body.response;

    const { data: product, error: productError } = await auth.supabase
      .from("products")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (productError) {
      console.error("Product image lookup:", productError.code, productError.message);
      return errorResponse("Unable to add product image", 500);
    }

    if (!product) {
      return errorResponse("Product not found", 404);
    }

    const { data, error } = await auth.supabase
      .from("product_images")
      .insert({ ...body.data, alt_text: body.data.alt_text || null, product_id: id })
      .select(PRODUCT_IMAGE_COLUMNS)
      .single();

    if (error) {
      return adminErrorResponse(error, "Add product image", "Unable to add product image");
    }

    return successResponse(data, "Product image added successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Add product image API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
