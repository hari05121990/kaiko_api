import { unstable_rethrow } from "next/navigation";
import { adminErrorResponse, requireGlobalAdmin } from "@/lib/admin/api";
import { ADMIN_PRODUCT_COLUMNS } from "@/lib/admin/catalog";
import { createProductSchema, slugify } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// products has admin-only RLS write policies (has_global_admin_role), so the
// insert runs with the caller's JWT and is re-authorised by the database.
export async function POST(request: Request) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, createProductSchema);
    if ("response" in body) return body.response;

    const slug = body.data.slug ?? slugify(body.data.name);
    if (!slug) {
      return errorResponse("slug: Unable to derive a slug from name; provide one", 400);
    }

    const { data, error } = await auth.supabase
      .from("products")
      .insert({ ...body.data, slug })
      .select(ADMIN_PRODUCT_COLUMNS)
      .single();

    if (error) {
      return adminErrorResponse(error, "Create product", "Unable to create product");
    }

    return successResponse(data, "Product created successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Create product API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
