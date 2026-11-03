import { createClient } from "@/lib/supabase/server";
import { dbError, fail, isUuid, ok } from "@/lib/kaiko/api";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return fail("Invalid product ID", 400);

  const supabase = await createClient();
  const { data, error } = await supabase.from("products")
    .select("*, product_images(*)")
    .eq("id", id)
    .eq("status", "active")
    .maybeSingle();

  if (error) return dbError(error, "Unable to retrieve product");
  if (!data) return fail("Product not found", 404);
  return ok(data, "Product retrieved successfully");
}
