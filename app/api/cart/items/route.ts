import { z } from "zod";
import { dbError, fail, getUserContext, ok, readJson } from "@/lib/kaiko/api";

const schema = z.object({
  product_id: z.string().uuid(),
  store_id: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(99).default(1),
});

export async function POST(request: Request) {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;

  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  const validation = schema.safeParse(parsed.data);
  if (!validation.success) return fail("Invalid cart item", 422, validation.error.flatten());

  const { product_id, store_id = null, quantity } = validation.data;
  const { data: product, error: productError } = await auth.supabase.from("products")
    .select("id")
    .eq("id", product_id)
    .eq("status", "active")
    .maybeSingle();

  if (productError) return dbError(productError, "Unable to validate product");
  if (!product) return fail("Product is unavailable", 404);

  let existingQuery = auth.supabase.from("cart_items").select("id, quantity")
    .eq("customer_id", auth.user.id).eq("product_id", product_id);
  existingQuery = store_id ? existingQuery.eq("store_id", store_id) : existingQuery.is("store_id", null);
  const { data: existing, error: findError } = await existingQuery.maybeSingle();
  if (findError) return dbError(findError, "Unable to check cart");

  if (existing) {
    const { data, error } = await auth.supabase.from("cart_items")
      .update({ quantity: existing.quantity + quantity })
      .eq("id", existing.id).eq("customer_id", auth.user.id)
      .select("*").single();
    if (error) return dbError(error, "Unable to update cart");
    return ok(data, "Cart quantity updated");
  }

  const { data, error } = await auth.supabase.from("cart_items")
    .insert({ customer_id: auth.user.id, product_id, store_id, quantity })
    .select("*").single();

  if (error) return dbError(error, "Unable to add item to cart");
  return ok(data, "Item added to cart", 201);
}
