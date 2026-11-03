import { z } from "zod";
import { dbError, fail, getUserContext, ok, readJson } from "@/lib/kaiko/api";

const schema = z.object({ product_id: z.string().uuid() });

export async function GET() {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;

  const { data, error } = await auth.supabase.from("wishlist_items")
    .select("*, products(*)")
    .eq("customer_id", auth.user.id)
    .order("created_at", { ascending: false });

  if (error) return dbError(error, "Unable to retrieve wishlist");
  return ok(data ?? [], "Wishlist retrieved successfully");
}

export async function POST(request: Request) {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;

  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  const validation = schema.safeParse(parsed.data);
  if (!validation.success) return fail("Valid product_id is required", 422);

  const { data: product, error: productError } = await auth.supabase.from("products")
    .select("id").eq("id", validation.data.product_id)
    .eq("status", "active").maybeSingle();
  if (productError) return dbError(productError, "Unable to validate product");
  if (!product) return fail("Product is unavailable", 404);

  const { data, error } = await auth.supabase.from("wishlist_items")
    .upsert(
      { customer_id: auth.user.id, product_id: validation.data.product_id },
      { onConflict: "customer_id,product_id", ignoreDuplicates: true },
    )
    .select("*")
    .maybeSingle();

  if (error) return dbError(error, "Unable to add product to wishlist");
  return ok(data, "Product added to wishlist", 201);
}
