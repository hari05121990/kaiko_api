import { createClient } from "@/lib/supabase/server";
import { dbError, ok } from "@/lib/kaiko/api";
import { getUserContext } from "@/lib/kaiko/api";

export async function GET() {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;

  const { data, error } = await auth.supabase.from("cart_items")
    .select("*, products(*)")
    .eq("customer_id", auth.user.id)
    .order("created_at", { ascending: false });

  if (error) return dbError(error, "Unable to retrieve cart");
  return ok(data ?? [], "Cart retrieved successfully");
}
