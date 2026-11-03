import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireUser, rpcErrorResponse } from "@/lib/customer/api";
import { addressIdSchema } from "@/lib/customer/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function PATCH(
  _request: NextRequest,
  ctx: RouteContext<"/api/customer/addresses/[id]/default">,
) {
  try {
    const { id } = await ctx.params;
    if (!addressIdSchema.safeParse(id).success) {
      return errorResponse("Invalid address ID", 400);
    }

    const auth = await requireUser();
    if ("response" in auth) return auth.response;

    const { data, error } = await auth.supabase.rpc("set_default_address", {
      p_address_id: id,
    });

    if (error) {
      return rpcErrorResponse(
        error,
        "Set default address",
        "Unable to set default address",
      );
    }

    if (data === false) {
      return errorResponse("Address not found", 404);
    }

    return successResponse(data, "Default address updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Set default address API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
