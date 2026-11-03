import { unstable_rethrow } from "next/navigation";
import {
  adminErrorResponse,
  firstRow,
  requireGlobalAdmin,
  requireRewardTarget,
} from "@/lib/admin/api";
import { creditPointsSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Points are derived from purchase_amount inside admin_credit_points; the
// client never supplies a point amount. Re-sending the same idempotency_key
// returns the original transaction instead of crediting twice.
export async function POST(request: Request) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, creditPointsSchema);
    if ("response" in body) return body.response;

    const { customer_id, purchase_amount, reference_id, description, idempotency_key } =
      body.data;

    const invalidTarget = await requireRewardTarget(auth, customer_id);
    if (invalidTarget) return invalidTarget;

    const { data, error } = await auth.supabase.rpc("admin_credit_points", {
      p_customer_id: customer_id,
      p_purchase_amount: purchase_amount,
      p_idempotency_key: idempotency_key,
      p_reference_id: reference_id ?? null,
      p_description: description || null,
    });

    if (error) {
      return adminErrorResponse(error, "Credit points", "Unable to credit reward points");
    }

    return successResponse(firstRow(data), "Reward points credited successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Credit points API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
