import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, readJson } from "@/lib/kaiko/api";

const schema = z.object({ email: z.email() });

export async function POST(request: Request) {
  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  const validation = schema.safeParse(parsed.data);
  if (!validation.success) return fail("A valid email address is required", 422);

  const supabase = await createClient();
  const redirectTo = process.env.NEXT_PUBLIC_SITE_URL
    ? `${process.env.NEXT_PUBLIC_SITE_URL}/reset-password`
    : undefined;

  const { error } = await supabase.auth.resetPasswordForEmail(
    validation.data.email,
    redirectTo ? { redirectTo } : undefined,
  );

  if (error) {
    console.error("Password reset request failed:", error.message);
    // Keep the response generic to avoid account enumeration.
  }
  return ok(null, "If an account exists for this email, password reset instructions have been sent");
}
