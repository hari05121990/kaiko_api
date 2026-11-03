import { dbError, fail, getUserContext, isUuid, ok } from "@/lib/kaiko/api";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const { id } = await params; if (!isUuid(id)) return fail("Invalid order ID", 400);
  const { data, error } = await auth.supabase.from("orders").select("id, order_number, order_status, delivery_status, fulfilment_type, created_at, updated_at")
    .eq("id", id).eq("customer_id", auth.user.id).maybeSingle();
  if (error) return dbError(error, "Unable to retrieve order status");
  if (!data) return fail("Order not found", 404);
  const { data: history, error: historyError } = await auth.supabase.from("order_status_history")
    .select("old_status, new_status, remarks, created_at").eq("order_id", id).order("created_at", { ascending: true });
  if (historyError) return dbError(historyError, "Unable to retrieve order tracking history");
  return ok({ ...data, history: history ?? [] }, "Order status retrieved successfully");
}
