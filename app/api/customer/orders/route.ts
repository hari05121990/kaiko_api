import { z } from "zod";
import { dbError, fail, getUserContext, ok, readJson } from "@/lib/kaiko/api";
const schema = z.object({ store_id: z.string().uuid(), fulfilment_type: z.enum(["PICKUP", "HOME_DELIVERY"]), address_id: z.string().uuid().nullable().optional(), customer_notes: z.string().trim().max(1000).nullable().optional(), idempotency_key: z.string().trim().min(8).max(150) });
export async function POST(request: Request) {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const parsed = await readJson(request); if ("response" in parsed) return parsed.response;
  const v = schema.safeParse(parsed.data); if (!v.success) return fail("Invalid checkout request", 422, v.error.flatten());
  if (v.data.fulfilment_type === "HOME_DELIVERY" && !v.data.address_id) return fail("A delivery address is required for home delivery", 422);
  const { data: cart, error: cartError } = await auth.supabase.from("cart_items").select("product_id, quantity")
    .eq("customer_id", auth.user.id).eq("store_id", v.data.store_id);
  if (cartError) return dbError(cartError, "Unable to retrieve cart");
  if (!cart?.length) return fail("Your cart is empty for this store", 400);
  const { data, error } = await auth.supabase.rpc("customer_checkout", {
    p_store_id: v.data.store_id,
    p_items: cart.map((x) => ({ product_id: x.product_id, quantity: x.quantity })),
    p_fulfilment_type: v.data.fulfilment_type,
    p_address_id: v.data.address_id ?? null,
    p_customer_notes: v.data.customer_notes ?? null,
    p_idempotency_key: v.data.idempotency_key,
  });
  if (error) {
    console.error("Customer checkout failed:", error.message);
    const msg = /insufficient|points/i.test(error.message) ? "Insufficient reward points" : /stock|inventory|available/i.test(error.message) ? "One or more products are unavailable or out of stock" : /address/i.test(error.message) ? "Invalid delivery address" : "Unable to place order";
    return fail(msg, 400);
  }
  // The checkout RPC is the transaction boundary. Clear cart only after it succeeds.
  const { error: clearError } = await auth.supabase.from("cart_items").delete().eq("customer_id", auth.user.id).eq("store_id", v.data.store_id);
  if (clearError) console.error("Order placed but cart cleanup failed:", clearError.message);
  return ok(data, "Order placed successfully", 201);
}
export async function GET(request: Request) {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const p = new URL(request.url).searchParams;
  const page = Number(p.get("page") ?? 1), limit = Number(p.get("limit") ?? 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) return fail("Invalid pagination parameters", 422);
  const from = (page - 1) * limit;
  const { data, error, count } = await auth.supabase.from("orders").select("*", { count: "exact" })
    .eq("customer_id", auth.user.id).order("created_at", { ascending: false }).range(from, from + limit - 1);
  if (error) return dbError(error, "Unable to retrieve orders");
  return ok({ items: data ?? [], pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) } }, "Orders retrieved successfully");
}
