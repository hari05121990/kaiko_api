import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { adminErrorResponse, requireGlobalAdmin } from "@/lib/admin/api";
import { ADMIN_CATEGORY_COLUMNS } from "@/lib/admin/catalog";
import { idSchema, updateCategorySchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/categories/[id]">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid category ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, updateCategorySchema);
    if ("response" in body) return body.response;

    const { data, error } = await auth.supabase
      .from("categories")
      .update(body.data)
      .eq("id", id)
      .select(ADMIN_CATEGORY_COLUMNS)
      .maybeSingle();

    if (error) {
      return adminErrorResponse(error, "Update category", "Unable to update category");
    }

    if (!data) {
      return errorResponse("Category not found", 404);
    }

    return successResponse(data, "Category updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Update category API error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// Only categories with no products (of any status) can be deleted; set status
// INACTIVE instead to hide a category that is still in use. The products
// foreign key also rejects the delete if a product is added concurrently.
export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext<"/api/admin/categories/[id]">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid category ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const { count, error: countError } = await auth.supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("category_id", id);

    if (countError) {
      console.error("Category product count:", countError.code, countError.message);
      return errorResponse("Unable to delete category", 500);
    }

    if (count) {
      return errorResponse(
        `Category has ${count} product(s); move them or set the category INACTIVE instead`,
        409,
      );
    }

    const { data, error } = await auth.supabase
      .from("categories")
      .delete()
      .eq("id", id)
      .select(ADMIN_CATEGORY_COLUMNS)
      .maybeSingle();

    if (error) {
      return adminErrorResponse(error, "Delete category", "Unable to delete category");
    }

    if (!data) {
      return errorResponse("Category not found", 404);
    }

    return successResponse(data, "Category deleted successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Delete category API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
