import { createClient } from "@/lib/supabase/server";
import { fail, ok } from "@/lib/kaiko/api";

export async function POST() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("Logout failed:", error.message);
    return fail("Unable to log out", 400);
  }
  return ok(null, "Logged out successfully");
}
