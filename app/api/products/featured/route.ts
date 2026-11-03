import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { dbError, fail, ok } from "@/lib/kaiko/api";

const schema = z.object({ limit: z.coerce.number().int().min(1).max(30).default(10) });

export async function GET(request: Request) {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) return fail("Invalid limit", 422);

  const supabase = await createClient();
  const { data, error } = await supabase.from("products")
    .select("*")
    .eq("status", "active")
    .eq("is_featured", true)
    .order("created_at", { ascending: false })
    .limit(parsed.data.limit);

  if (error) return dbError(error, "Unable to retrieve featured products");
  return ok(data ?? [], "Featured products retrieved successfully");
}
