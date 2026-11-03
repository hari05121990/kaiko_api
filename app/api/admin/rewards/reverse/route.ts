import { unstable_rethrow } from "next/navigation";
import {
  adminErrorResponse,
  firstRow,
  requireGlobalAdmin,
  requireRewardTarget,
} from "@/lib/admin/api";
import { reversePointsSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Fully reverses one purchase CREDIT. Eligibility, double-reversal and balance
// checks are enforced by admin_reverse_points.
export async function POST(request: Request) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, reversePointsSchema);
    if ("response" in body) return body.response;

    const { transaction_id, reason, idempotency_key } = body.data;

    // Resolve the credited customer to apply the same target checks as credit/adjust.
    const { data: original, error: lookupError } = await auth.supabase
      .from("reward_transactions")
      .select("id, wallet:reward_wallets ( customer_id )")
      .eq("id", transaction_id)
      .maybeSingle();

    if (lookupError) {
      console.error("Reverse points lookup:", lookupError.code, lookupError.message);
      return errorResponse("Unable to reverse reward points", 500);
    }

    const wallet = original?.wallet as unknown as { customer_id: string } | null;
    if (!wallet) {
      return errorResponse("Original reward transaction not found", 404);
    }

    const invalidTarget = await requireRewardTarget(auth, wallet.customer_id);
    if (invalidTarget) return invalidTarget;

    const { data, error } = await auth.supabase.rpc("admin_reverse_points", {
      p_original_transaction_id: transaction_id,
      p_idempotency_key: idempotency_key,
      p_reason: reason,
    });

    if (error) {
      return adminErrorResponse(error, "Reverse points", "Unable to reverse reward points");
    }

    return successResponse(firstRow(data), "Reward points reversed successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Reverse points API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
