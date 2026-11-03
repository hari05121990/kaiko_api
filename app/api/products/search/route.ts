import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { dbError, fail, ok } from "@/lib/kaiko/api";

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(["newest", "price_asc", "price_desc", "name_asc"]).default("newest"),
});

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse(Object.fromEntries(params.entries()));
  if (!parsed.success) return fail("Invalid search parameters", 422, parsed.error.flatten());

  const { q, category_id, page, limit, sort } = parsed.data;
  const supabase = await createClient();
  let query = supabase.from("products").select("*", { count: "exact" }).eq("status", "active");

  if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%,sku.ilike.%${q}%`);
  if (category_id) query = query.eq("category_id", category_id);

  if (sort === "price_asc") query = query.order("price", { ascending: true });
  else if (sort === "price_desc") query = query.order("price", { ascending: false });
  else if (sort === "name_asc") query = query.order("name", { ascending: true });
  else query = query.order("created_at", { ascending: false });

  const from = (page - 1) * limit;
  const { data, error, count } = await query.range(from, from + limit - 1);
  if (error) return dbError(error, "Unable to search products");

  return ok({
    items: data ?? [],
    pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) },
  }, "Products retrieved successfully");
}
