import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAuthAdmin } from "@/lib/supabase/auth-admin";
import { fail, ok, readJson } from "@/lib/kaiko/api";

const schema = z.object({
  email: z.email(),
  password: z.string().min(8).max(72),
  full_name: z.string().trim().min(2).max(120),
});

export async function POST(request: Request) {
  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;

  const validation = schema.safeParse(parsed.data);
  if (!validation.success) return fail("Validation failed", 422, validation.error.flatten());

  const { email, password, full_name } = validation.data;

  // Created through the Auth admin API with email_confirm so no confirmation
  // email (and no SMTP setup) is needed. The auth.users insert still fires the
  // database trigger that creates the profiles row.
  // Never accept a customer/profile ID from the request body.
  const { data: created, error: createError } = await createAuthAdmin().createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
  });

  if (createError || !created.user) {
    // Log codes only: Auth messages may echo the email address.
    console.error("Signup create user:", createError?.code, createError?.status);
    if (createError?.code === "email_exists" || createError?.code === "user_already_exists") {
      return fail("Email is already registered", 409);
    }
    if (createError?.code === "weak_password") {
      return fail("Password does not meet the password policy", 400);
    }
    if (createError?.code === "email_address_invalid") {
      return fail("Invalid email address", 400);
    }
    return fail("Unable to create account", 400);
  }

  // Sign in on the server client so the session cookies are set as well.
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    console.error("Signup sign-in failed:", error.code, error.status);
    return ok(
      { user: created.user, session: null },
      "Account created. Log in to continue.",
      201,
    );
  }

  return ok({ user: data.user, session: data.session }, "Account created successfully", 201);
}
