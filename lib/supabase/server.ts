import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";

// Non-browser clients (Postman, mobile apps) authenticate with
// "Authorization: Bearer <access_token>" instead of session cookies.
async function getBearerToken() {
  const authorization = (await headers()).get("authorization");
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
}

export async function createClient() {
  const cookieStore = await cookies();
  const accessToken = await getBearerToken();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      ...(accessToken && {
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Cookie updates may not be available
            // in read-only Server Component contexts.
          }
        },
      },
    },
  );
}

// Resolves the user from the bearer token if present, otherwise from cookies.
export async function getAuthUser(supabase: SupabaseClient) {
  return supabase.auth.getUser(await getBearerToken());
}
