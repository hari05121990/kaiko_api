import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  requireUser,
  rpcErrorResponse,
  validationMessage,
} from "@/lib/customer/api";
import { rewardHistoryQuerySchema } from "@/lib/customer/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser();
    if ("response" in auth) return auth.response;

    const params = request.nextUrl.searchParams;
    const query = rewardHistoryQuerySchema.safeParse({
      page: params.get("page") ?? undefined,
      limit: params.get("limit") ?? undefined,
    });

    if (!query.success) {
      return errorResponse(validationMessage(query.error), 400);
    }

    const { page, limit } = query.data;

    const { data, error } = await auth.supabase.rpc("get_my_reward_history", {
      p_limit: limit,
      p_offset: (page - 1) * limit,
    });

    if (error) {
      return rpcErrorResponse(
        error,
        "Reward history",
        "Unable to retrieve reward history",
      );
    }

    return successResponse(
      { transactions: data ?? [], pagination: { page, limit } },
      "Reward history retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Reward history API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
