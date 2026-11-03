import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  adminErrorResponse,
  pageRange,
  pagination,
  parseQuery,
  requireGlobalAdmin,
  requireStaff,
  searchPattern,
} from "@/lib/admin/api";
import { ADMIN_STORE_COLUMNS } from "@/lib/admin/catalog";
import { createStoreSchema, storeListQuerySchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Global admins see every store; store-level staff only their assigned stores
// (RLS alone would also show them every ACTIVE store).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, storeListQuerySchema);
    if ("response" in query) return query.response;

    const { page, limit, q, status } = query.data;

    let storesQuery = auth.supabase
      .from("stores")
      .select(ADMIN_STORE_COLUMNS, { count: "exact" });

    if (!auth.isGlobalAdmin) storesQuery = storesQuery.in("id", auth.storeIds);
    if (status) storesQuery = storesQuery.eq("status", status);
    if (q) {
      const pattern = searchPattern(q);
      storesQuery = storesQuery.or(
        `store_name.ilike.${pattern},store_code.ilike.${pattern},city.ilike.${pattern}`,
      );
    }

    const [from, to] = pageRange(page, limit);

    const { data, error, count } = await storesQuery
      .order("store_name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      console.error("Admin stores:", error.code, error.message);
      return errorResponse("Unable to retrieve stores", 500);
    }

    return successResponse(
      { stores: data ?? [], pagination: pagination(page, limit, count) },
      "Stores retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Admin stores API error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// stores has admin-only RLS write policies (has_global_admin_role).
export async function POST(request: Request) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, createStoreSchema);
    if ("response" in body) return body.response;

    const { data, error } = await auth.supabase
      .from("stores")
      .insert(body.data)
      .select(ADMIN_STORE_COLUMNS)
      .single();

    if (error) {
      return adminErrorResponse(error, "Create store", "Unable to create store");
    }

    return successResponse(data, "Store created successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Create store API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
