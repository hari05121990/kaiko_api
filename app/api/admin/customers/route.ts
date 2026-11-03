import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  adminErrorResponse,
  firstRow,
  pageRange,
  parseQuery,
  requireGlobalAdmin,
} from "@/lib/admin/api";
import { createCustomerSchema, customerListQuerySchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { createAuthAdmin } from "@/lib/supabase/auth-admin";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Requires Migration 008 (admin_list_customers).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, customerListQuerySchema);
    if ("response" in query) return query.response;

    const { page, limit, q, status } = query.data;
    const [offset] = pageRange(page, limit);

    const { data, error } = await auth.supabase.rpc("admin_list_customers", {
      p_search: q ?? null,
      p_status: status ?? null,
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      return adminErrorResponse(error, "List customers", "Unable to retrieve customers");
    }

    const rows = (data ?? []) as Array<Record<string, unknown> & { total_count?: number }>;
    // total_count is repeated on every row and only present when the page has rows.
    const total = rows.length ? Number(rows[0].total_count) : page === 1 ? 0 : null;
    const customers = rows.map((row) => {
      const customer = { ...row };
      delete customer.total_count;
      return customer;
    });

    return successResponse(
      {
        customers,
        pagination: {
          page,
          limit,
          total,
          totalPages: total === null ? null : Math.ceil(total / limit),
        },
      },
      "Customers retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("List customers API error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// Requires Migration 008 (admin_create_customer_profile).
// 1. Creates the Supabase Auth user with the service role (server-side only).
// 2. admin_create_customer_profile, called with the admin's own JWT, re-checks
//    admin rights, duplicate mobile/email/profile, inserts the profile and the
//    CUSTOMER role; the profiles trigger creates the reward wallet.
// 3. If step 2 fails, the Auth user is deleted so no orphan login remains.
export async function POST(request: Request) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, createCustomerSchema);
    if ("response" in body) return body.response;

    const { full_name, mobile, email, password, address, city, state, pincode } =
      body.data;

    const authAdmin = createAuthAdmin();

    const { data: created, error: createError } = await authAdmin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });

    if (createError || !created.user) {
      // Log codes only: Auth messages may echo the email address.
      console.error("Create customer auth user:", createError?.code, createError?.status);

      if (createError?.code === "email_exists" || createError?.code === "user_already_exists") {
        return errorResponse("Email is already registered", 409);
      }
      if (createError?.code === "weak_password") {
        return errorResponse("Password does not meet the password policy", 400);
      }
      if (createError?.code === "email_address_invalid") {
        return errorResponse("Invalid email address", 400);
      }
      return errorResponse("Unable to create customer", 500);
    }

    const { data, error } = await auth.supabase.rpc("admin_create_customer_profile", {
      p_user_id: created.user.id,
      p_full_name: full_name,
      p_mobile: mobile,
      p_email: email,
      p_address: address || null,
      p_city: city || null,
      p_state: state || null,
      p_pincode: pincode ?? null,
    });

    if (error) {
      const { error: deleteError } = await authAdmin.deleteUser(created.user.id);
      if (deleteError) {
        console.error(
          "Create customer rollback failed; remove Auth user manually:",
          created.user.id,
          deleteError.code,
        );
      }
      return adminErrorResponse(error, "Create customer", "Unable to create customer");
    }

    return successResponse(firstRow(data), "Customer created successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Create customer API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
