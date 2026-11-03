import { createClient } from "@/lib/supabase/server";
import { dbError, fail, isUuid, ok } from "@/lib/kaiko/api";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return fail("Invalid product ID", 400);

  const supabase = await createClient();
  const { data: product, error: productError } = await supabase.from("products")
    .select("category_id")
    .eq("id", id)
    .eq("status", "active")
    .maybeSingle();

  if (productError) return dbError(productError, "Unable to retrieve product");
  if (!product) return fail("Product not found", 404);
  if (!product.category_id) return ok([], "No related products found");

  const { data, error } = await supabase.from("products")
    .select("*")
    .eq("category_id", product.category_id)
    .eq("status", "active")
    .neq("id", id)
    .order("created_at", { ascending: false })
    .limit(8);

  if (error) return dbError(error, "Unable to retrieve related products");
  return ok(data ?? [], "Related products retrieved successfully");
}
