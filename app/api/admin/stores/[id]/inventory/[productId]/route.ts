import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { canAccessStore, requireStaff } from "@/lib/admin/api";
import { idSchema, inventoryAdjustmentSchema } from "@/lib/admin/schemas";
import { parseBody } from "@/lib/customer/api";
import { errorResponse } from "@/lib/utils/api-response";

// BLOCKED: no atomic inventory RPC exists in the database.
// A safe adjustment must lock the store_products row, change stock_quantity
// and insert the matching inventory_transactions row in one transaction.
// `authenticated` has no write grant on inventory_transactions, so doing this
// from Next.js would change stock without a ledger entry. The route authorises
// and validates the request contract, then reports the missing dependency.
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/stores/[id]/inventory/[productId]">,
) {
  try {
    const { id, productId } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("Invalid store ID", 400);
    }
    if (!idSchema.safeParse(productId).success) {
      return errorResponse("Invalid product ID", 400);
    }

    const auth = await requireStaff();
    if ("response" in auth) return auth.response;

    if (!canAccessStore(auth, id)) {
      return errorResponse("You do not have access to this store", 403);
    }

    const body = await parseBody(request, inventoryAdjustmentSchema);
    if ("response" in body) return body.response;

    return errorResponse(
      "Stock adjustment is not available yet: it requires an atomic inventory database function that records inventory_transactions",
      501,
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Adjust inventory API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
