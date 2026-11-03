import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  adminErrorResponse,
  canAccessStore,
  requireGlobalAdmin,
  requireStaff,
} from "@/lib/admin/api";
import { ADMIN_STORE_COLUMNS } from "@/lib/admin/catalog";
import { idSchema, updateStoreSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/admin/stores/[id]">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid store ID", 400);
    }

    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    if (!canAccessStore(auth, id)) {
      return errorResponse("You do not have access to this store", 403);
    }

    const { data, error } = await auth.supabase
      .from("stores")
      .select(ADMIN_STORE_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("Admin store details:", error.code, error.message);
      return errorResponse("Unable to retrieve store", 500);
    }

    if (!data) {
      return errorResponse("Store not found", 404);
    }

    return successResponse(data, "Store retrieved successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Admin store details API error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/stores/[id]">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid store ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, updateStoreSchema);
    if ("response" in body) return body.response;

    const { data, error } = await auth.supabase
      .from("stores")
      .update(body.data)
      .eq("id", id)
      .select(ADMIN_STORE_COLUMNS)
      .maybeSingle();

    if (error) {
      return adminErrorResponse(error, "Update store", "Unable to update store");
    }

    if (!data) {
      return errorResponse("Store not found", 404);
    }

    return successResponse(data, "Store updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Update store API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
