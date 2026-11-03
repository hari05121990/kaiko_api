import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { adminErrorResponse, firstRow, requireGlobalAdmin } from "@/lib/admin/api";
import { idSchema, updateCustomerSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Requires Migration 008 (admin_get_customer).
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/admin/customers/[id]">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid customer ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const { data, error } = await auth.supabase.rpc("admin_get_customer", {
      p_customer_id: id,
    });

    if (error) {
      return adminErrorResponse(error, "Get customer", "Unable to retrieve customer");
    }

    const customer = firstRow(data);
    if (!customer) {
      return errorResponse("Customer not found", 404);
    }

    return successResponse(customer, "Customer retrieved successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Get customer API error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// Requires Migration 008 (admin_update_customer).
// Omitted fields are kept; null or "" clears address, city, state or pincode.
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/customers/[id]">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid customer ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, updateCustomerSchema);
    if ("response" in body) return body.response;

    const { full_name, mobile, address, city, state, pincode } = body.data;
    // admin_update_customer: NULL keeps the current value, "" clears it.
    const clearable = (value: string | null | undefined) =>
      value === undefined ? null : (value ?? "");

    const { data, error } = await auth.supabase.rpc("admin_update_customer", {
      p_customer_id: id,
      p_full_name: full_name ?? null,
      p_mobile: mobile ?? null,
      p_address: clearable(address),
      p_city: clearable(city),
      p_state: clearable(state),
      p_pincode: clearable(pincode),
    });

    if (error) {
      return adminErrorResponse(error, "Update customer", "Unable to update customer");
    }

    return successResponse(firstRow(data), "Customer updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Update customer API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
