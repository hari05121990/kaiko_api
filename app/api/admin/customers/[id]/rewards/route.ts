import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  pageRange,
  pagination,
  parseQuery,
  requireCustomerAccount,
  requireGlobalAdmin,
} from "@/lib/admin/api";
import { customerRewardsQuerySchema, idSchema } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Read-only ledger. reward_transactions RLS allows global admins to read all rows.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/customers/[id]/rewards">,
) {
  try {
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid customer ID", 400);
    }

    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, customerRewardsQuerySchema);
    if ("response" in query) return query.response;

    const notCustomer = await requireCustomerAccount(auth.supabase, id);
    if (notCustomer) return notCustomer;

    const { data: wallet, error: walletError } = await auth.supabase
      .from("reward_wallets")
      .select("id, balance")
      .eq("customer_id", id)
      .maybeSingle();

    if (walletError) {
      console.error("Customer rewards wallet:", walletError.code, walletError.message);
      return errorResponse("Unable to retrieve reward history", 500);
    }

    if (!wallet) {
      return errorResponse("Wallet not found", 404);
    }

    const { page, limit, type } = query.data;
    const [from, to] = pageRange(page, limit);

    let transactionsQuery = auth.supabase
      .from("reward_transactions")
      .select(
        "id, transaction_type, points, reference_type, reference_id, purchase_amount, description, idempotency_key, created_by, created_at",
        { count: "exact" },
      )
      .eq("wallet_id", wallet.id);

    if (type) {
      transactionsQuery = transactionsQuery.eq("transaction_type", type);
    }

    const { data, error, count } = await transactionsQuery
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("Customer rewards:", error.code, error.message);
      return errorResponse("Unable to retrieve reward history", 500);
    }

    return successResponse(
      {
        wallet_id: wallet.id,
        balance: wallet.balance,
        transactions: data ?? [],
        pagination: pagination(page, limit, count),
      },
      "Reward history retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Customer rewards API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
