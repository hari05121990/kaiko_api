import { z } from "zod";
import { dbError, fail, getUserContext, ok, readJson } from "@/lib/kaiko/api";
const schema = z.object({ store_id: z.string().uuid(), fulfilment_type: z.enum(["PICKUP", "HOME_DELIVERY"]), address_id: z.string().uuid().nullable().optional() });
export async function POST(request: Request) {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const parsed = await readJson(request); if ("response" in parsed) return parsed.response;
  const v = schema.safeParse(parsed.data); if (!v.success) return fail("Invalid checkout details", 422, v.error.flatten());
  if (v.data.fulfilment_type === "HOME_DELIVERY" && !v.data.address_id) return fail("A delivery address is required for home delivery", 422);
  if (v.data.address_id) {
    const { data, error } = await auth.supabase.from("customer_addresses").select("id")
      .eq("id", v.data.address_id).eq("customer_id", auth.user.id).maybeSingle();
    if (error) return dbError(error, "Unable to validate delivery address");
    if (!data) return fail("Delivery address not found", 404);
  }
  const { data: cart, error } = await auth.supabase.from("cart_items")
    .select("product_id, quantity, products(id, name, sku, price, points_required, status)")
    .eq("customer_id", auth.user.id).eq("store_id", v.data.store_id).order("created_at");
  if (error) return dbError(error, "Unable to retrieve cart");
  if (!cart?.length) return fail("Your cart is empty for this store", 400);
  const items = cart.map((row: any) => {
    const p = Array.isArray(row.products) ? row.products[0] : row.products;
    if (!p || p.status !== "ACTIVE") return null;
    const points = p.points_required ?? Math.ceil(Number(p.price));
    if (!Number.isSafeInteger(points) || points < 0) return null;
    return { product_id: row.product_id, product_name: p.name, sku: p.sku, quantity: row.quantity, points_per_unit: points, total_points: points * row.quantity };
  });
  if (items.some((x) => x === null)) return fail("One or more products are unavailable or have invalid points pricing", 409);
  const total = items.reduce((sum, x) => sum + x!.total_points, 0);
  const { data: wallet, error: walletError } = await auth.supabase.from("reward_wallets").select("balance")
    .eq("customer_id", auth.user.id).maybeSingle();
  if (walletError) return dbError(walletError, "Unable to retrieve wallet");
  const balance = Number(wallet?.balance ?? 0);
  return ok({ store_id: v.data.store_id, fulfilment_type: v.data.fulfilment_type, items, total_points: total, available_points: balance, points_shortfall: Math.max(total - balance, 0), can_checkout: balance >= total }, "Checkout preview calculated successfully");
}
