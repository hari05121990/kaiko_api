import { dbError, fail, getUserContext, isUuid, ok } from "@/lib/kaiko/api";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Context) {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return fail("Invalid product ID", 400);

  const { data, error } = await auth.supabase.from("wishlist_items")
    .delete()
    .eq("product_id", id)
    .eq("customer_id", auth.user.id)
    .select("product_id")
    .maybeSingle();

  if (error) return dbError(error, "Unable to remove wishlist item");
  if (!data) return fail("Wishlist item not found", 404);
  return ok(data, "Product removed from wishlist");
}
