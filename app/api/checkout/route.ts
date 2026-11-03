import { unstable_rethrow } from "next/navigation";
import { parseBody, requireUser, rpcErrorResponse } from "@/lib/customer/api";
import { checkoutSchema } from "@/lib/orders/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Pricing, stock, points, address ownership and idempotency are all enforced
// inside customer_checkout; this route only validates shape and forwards.
export async function POST(request: Request) {
  try {
    const auth = await requireUser();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, checkoutSchema);
    if ("response" in body) return body.response;

    const {
      store_id,
      items,
      fulfilment_type,
      address_id,
      customer_notes,
      idempotency_key,
    } = body.data;

    const { data, error } = await auth.supabase.rpc("customer_checkout", {
      p_store_id: store_id,
      p_items: items,
      p_fulfilment_type: fulfilment_type,
      p_address_id: address_id ?? null,
      p_customer_notes: customer_notes || null,
      p_idempotency_key: idempotency_key,
    });

    if (error) {
      return rpcErrorResponse(error, "Checkout", "Unable to place order");
    }

    return successResponse(data, "Order placed successfully", 201);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Checkout API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
