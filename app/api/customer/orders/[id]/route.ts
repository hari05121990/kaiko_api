import { dbError, fail, getUserContext, isUuid, ok } from "@/lib/kaiko/api";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const { id } = await params; if (!isUuid(id)) return fail("Invalid order ID", 400);
  const { data: order, error } = await auth.supabase.from("orders").select("*")
    .eq("id", id).eq("customer_id", auth.user.id).maybeSingle();
  if (error) return dbError(error, "Unable to retrieve order");
  if (!order) return fail("Order not found", 404);
  const [itemsResult, historyResult] = await Promise.all([
    auth.supabase.from("order_items").select("*").eq("order_id", id),
    auth.supabase.from("order_status_history").select("*").eq("order_id", id).order("created_at", { ascending: true }),
  ]);
  if (itemsResult.error) return dbError(itemsResult.error, "Unable to retrieve order items");
  if (historyResult.error) return dbError(historyResult.error, "Unable to retrieve order status history");
  return ok({ ...order, items: itemsResult.data ?? [], status_history: historyResult.data ?? [] }, "Order retrieved successfully");
}
