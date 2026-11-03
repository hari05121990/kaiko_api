import { z } from "zod";
import { dbError, fail, getUserContext, isUuid, ok, readJson } from "@/lib/kaiko/api";
type Context = { params: Promise<{ id: string }> };
const schema = z.object({
  address_name: z.string().trim().min(1).max(60).optional(),
  recipient_name: z.string().trim().min(2).max(120).optional(),
  mobile: z.string().trim().min(7).max(20).optional(),
  address_line1: z.string().trim().min(3).max(200).optional(),
  address_line2: z.string().trim().max(200).nullable().optional(),
  landmark: z.string().trim().max(150).nullable().optional(),
  city: z.string().trim().min(2).max(100).optional(),
  state: z.string().trim().min(2).max(100).optional(),
  pincode: z.string().trim().regex(/^[0-9]{5,10}$/).optional(),
  is_default: z.boolean().optional(),
}).strict();
export async function PATCH(request: Request, { params }: Context) {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const { id } = await params; if (!isUuid(id)) return fail("Invalid address ID", 400);
  const parsed = await readJson(request); if ("response" in parsed) return parsed.response;
  const v = schema.safeParse(parsed.data);
  if (!v.success || Object.keys(v.data ?? {}).length === 0) return fail("Invalid address update", 422, v.success ? undefined : v.error.flatten());
  const { data, error } = await auth.supabase.from("customer_addresses").update({ ...v.data, updated_at: new Date().toISOString() })
    .eq("id", id).eq("customer_id", auth.user.id).select("*").maybeSingle();
  if (error) return dbError(error, "Unable to update address", 400);
  if (!data) return fail("Address not found", 404);
  return ok(data, "Address updated successfully");
}
export async function DELETE(_request: Request, { params }: Context) {
  const auth = await getUserContext(); if ("response" in auth) return auth.response;
  const { id } = await params; if (!isUuid(id)) return fail("Invalid address ID", 400);
  const { data, error } = await auth.supabase.from("customer_addresses").delete()
    .eq("id", id).eq("customer_id", auth.user.id).select("id").maybeSingle();
  if (error) return dbError(error, "Unable to delete address", 400);
  if (!data) return fail("Address not found", 404);
  return ok(data, "Address deleted successfully");
}
