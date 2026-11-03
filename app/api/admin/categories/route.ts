import { unstable_rethrow } from "next/navigation";
import { adminErrorResponse, requireGlobalAdmin } from "@/lib/admin/api";
import { ADMIN_CATEGORY_COLUMNS } from "@/lib/admin/catalog";
import { createCategorySchema, slugify } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// categories has admin-only RLS write policies (has_global_admin_role).
export async function POST(request: Request) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, createCategorySchema);
    if ("response" in body) return body.response;

    const slug = body.data.slug ?? slugify(body.data.name);
    if (!slug) {
      return errorResponse("slug: Unable to derive a slug from name; provide one", 400);
    }

    const { data, error } = await auth.supabase
      .from("categories")
      .insert({ ...body.data, slug })
      .select(ADMIN_CATEGORY_COLUMNS)
      .single();

    if (error) {
      return adminErrorResponse(error, "Create category", "Unable to create category");
    }

    return successResponse(data, "Category created successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Create category API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
