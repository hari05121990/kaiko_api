import { createClient } from "@supabase/supabase-js";

// Supabase Auth admin API (create/delete Auth users) for server-side route
// handlers only. SUPABASE_SERVICE_ROLE_KEY bypasses RLS: it is not a
// NEXT_PUBLIC_ variable, so it is never bundled for the browser, and only the
// auth.admin namespace is returned so it cannot be used for table access.
// Callers must authorise the request (requireGlobalAdmin) before using this.
export function createAuthAdmin() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }).auth.admin;
}
