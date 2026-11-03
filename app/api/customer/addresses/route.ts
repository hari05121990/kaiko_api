import { z } from "zod";
import { dbError, fail, getUserContext, ok, readJson } from "@/lib/kaiko/api";

const schema = z.object({
  address_name: z.string().trim().min(1).max(60),
  recipient_name: z.string().trim().min(2).max(120),
  mobile: z.string().trim().min(7).max(20),
  address_line1: z.string().trim().min(3).max(200),
  address_line2: z.string().trim().max(200).nullable().optional(),
  landmark: z.string().trim().max(150).nullable().optional(),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(100),
  pincode: z.string().trim().regex(/^[0-9]{5,10}$/),
  is_default: z.boolean().default(false),
});

export async function GET() {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;
  const { data, error } = await auth.supabase.from("customer_addresses").select("*")
    .eq("customer_id", auth.user.id).order("is_default", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return dbError(error, "Unable to retrieve addresses");
  return ok(data ?? [], "Addresses retrieved successfully");
}

export async function POST(request: Request) {
  const auth = await getUserContext();
  if ("response" in auth) return auth.response;
  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  const validation = schema.safeParse(parsed.data);
  if (!validation.success) return fail("Invalid address details", 422, validation.error.flatten());
  const { data, error } = await auth.supabase.from("customer_addresses")
    .insert({ ...validation.data, customer_id: auth.user.id }).select("*").single();
  if (error) return dbError(error, "Unable to save address", 400);
  return ok(data, "Address added successfully", 201);
}
