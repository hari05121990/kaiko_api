import { NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";

export function ok(data: unknown, message = "Success", status = 200) {
  return NextResponse.json({ success: true, message, data }, { status });
}

export function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json(
    {
      success: false,
      message,
      ...(details ? { details } : {}),
    },
    { status },
  );
}

export async function getUserContext(): Promise<
  { supabase: SupabaseClient; user: User } | { response: NextResponse }
> {
  const supabase = await createClient();
  const { data, error } = await getAuthUser(supabase);

  if (error || !data.user) {
    return { response: fail("Authentication required", 401) };
  }

  return { supabase, user: data.user };
}

export async function readJson(request: Request) {
  try {
    const value: unknown = await request.json();

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        response: fail("Request body must be a JSON object", 400),
      };
    }

    return { data: value as Record<string, unknown> };
  } catch {
    return {
      response: fail("Invalid JSON request body", 400),
    };
  }
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function dbError(
  error: { message: string },
  fallback: string,
  status = 500,
) {
  console.error(fallback, error.message);
  return fail(fallback, status);
}
