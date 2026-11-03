import { z } from "zod";
import { dbError, fail, getUserContext, ok } from "@/lib/kaiko/api";
const schema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) });
export async function GET(request: Request) {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const v = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!v.success) return fail("Invalid pagination parameters", 422);
  const { data: wallet, error: walletError } = await auth.supabase.from("reward_wallets").select("id")
    .eq("customer_id", auth.user.id).maybeSingle();
  if (walletError) return dbError(walletError, "Unable to retrieve wallet");
  if (!wallet) return ok({ items: [], pagination: { page: v.data.page, limit: v.data.limit, total: 0, total_pages: 0 } });
  const from = (v.data.page - 1) * v.data.limit;
  const { data, error, count } = await auth.supabase.from("reward_transactions")
    .select("id, wallet_id, transaction_type, points, reference_type, reference_id, purchase_amount, description, created_at", { count: "exact" })
    .eq("wallet_id", wallet.id).order("created_at", { ascending: false }).range(from, from + v.data.limit - 1);
  if (error) return dbError(error, "Unable to retrieve wallet transactions");
  return ok({ items: data ?? [], pagination: { page: v.data.page, limit: v.data.limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / v.data.limit) } });
}
