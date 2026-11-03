import { dbError, getUserContext, ok } from "@/lib/kaiko/api";
export async function GET() {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const { data, error } = await auth.supabase.from("reward_wallets").select("id, balance, created_at, updated_at")
    .eq("customer_id", auth.user.id).maybeSingle();
  if (error) return dbError(error, "Unable to retrieve wallet");
  return ok(data ?? { balance: 0 }, "Wallet retrieved successfully");
}
