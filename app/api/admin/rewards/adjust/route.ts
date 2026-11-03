import { unstable_rethrow } from "next/navigation";
import {
  adminErrorResponse,
  firstRow,
  requireGlobalAdmin,
  requireRewardTarget,
} from "@/lib/admin/api";
import { adjustPointsSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Manual CREDIT/DEBIT with a mandatory reason. Balance checks, the ledger row
// and the audit log are handled by admin_adjust_points.
export async function POST(request: Request) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, adjustPointsSchema);
    if ("response" in body) return body.response;

    const { customer_id, direction, points, reason, idempotency_key } = body.data;

    const invalidTarget = await requireRewardTarget(auth, customer_id);
    if (invalidTarget) return invalidTarget;

    const { data, error } = await auth.supabase.rpc("admin_adjust_points", {
      p_customer_id: customer_id,
      p_direction: direction,
      p_points: points,
      p_reason: reason,
      p_idempotency_key: idempotency_key,
    });

    if (error) {
      return adminErrorResponse(error, "Adjust points", "Unable to adjust reward points");
    }

    return successResponse(firstRow(data), "Reward points adjusted successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Adjust points API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
