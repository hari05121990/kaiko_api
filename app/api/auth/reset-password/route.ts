import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, readJson } from "@/lib/kaiko/api";

const schema = z.object({ password: z.string().min(8).max(72) });

export async function POST(request: Request) {
  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  const validation = schema.safeParse(parsed.data);
  if (!validation.success) return fail("Password must contain at least 8 characters", 422);

  // Supabase recovery link must first establish a recovery session in the browser.
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return fail("Valid password recovery session required", 401);

  const { error } = await supabase.auth.updateUser({ password: validation.data.password });
  if (error) {
    console.error("Password update failed:", error.message);
    return fail("Unable to reset password", 400);
  }
  return ok(null, "Password updated successfully");
}
