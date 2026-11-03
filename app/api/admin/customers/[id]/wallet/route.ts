import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireCustomerAccount, requireGlobalAdmin } from "@/lib/admin/api";
import { idSchema } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Read-only. reward_wallets RLS allows global admins to read any wallet.
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/admin/customers/[id]/wallet">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid customer ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const notCustomer = await requireCustomerAccount(auth.supabase, id);
    if (notCustomer) return notCustomer;

    const { data, error } = await auth.supabase
      .from("reward_wallets")
      .select("id, customer_id, balance, created_at, updated_at")
      .eq("customer_id", id)
      .maybeSingle();

    if (error) {
      console.error("Customer wallet:", error.code, error.message);
      return errorResponse("Unable to retrieve wallet", 500);
    }

    if (!data) {
      return errorResponse("Wallet not found", 404);
    }

    return successResponse(data, "Wallet retrieved successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Customer wallet API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
