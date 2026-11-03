import { z } from "zod";
import { dbError, fail, getUserContext, isUuid, ok, readJson } from "@/lib/kaiko/api";

type Context = { params: Promise<{ id: string }> };
const schema = z.object({ quantity: z.number().int().min(1).max(99) });

export async function PATCH(request: Request, { params }: Context) {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return fail("Invalid cart item ID", 400);

  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  const validation = schema.safeParse(parsed.data);
  if (!validation.success) return fail("Quantity must be between 1 and 99", 422);

  const { data, error } = await auth.supabase.from("cart_items")
    .update({ quantity: validation.data.quantity })
    .eq("id", id).eq("customer_id", auth.user.id)
    .select("*").maybeSingle();

  if (error) return dbError(error, "Unable to update cart item");
  if (!data) return fail("Cart item not found", 404);
  return ok(data, "Cart item updated successfully");
}

export async function DELETE(_request: Request, { params }: Context) {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return fail("Invalid cart item ID", 400);

  const { data, error } = await auth.supabase.from("cart_items")
    .delete().eq("id", id).eq("customer_id", auth.user.id)
    .select("id").maybeSingle();

  if (error) return dbError(error, "Unable to remove cart item");
  if (!data) return fail("Cart item not found", 404);
  return ok({ id }, "Cart item removed successfully");
}
