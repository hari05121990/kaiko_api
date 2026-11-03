import type { PostgrestError } from "@supabase/supabase-js";
import type { z } from "zod";
import { createClient, getAuthUser } from "@/lib/supabase/server";
import { errorResponse } from "@/lib/utils/api-response";

// Returns an authenticated Supabase client, or a 401 response to send back.
export async function requireUser() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await getAuthUser(supabase);

  if (error || !user) {
    return { response: errorResponse("Authentication required", 401) } as const;
  }

  return { supabase, user } as const;
}

// Formats the first Zod issue as a client-safe message, e.g. "pincode: Invalid pincode".
export function validationMessage(error: z.ZodError) {
  const issue = error.issues[0];
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

// Parses a JSON body against a schema, returning either the data or a 400 response.
export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: errorResponse("Request body must be valid JSON", 400) } as const;
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return { response: errorResponse(validationMessage(result.error), 400) } as const;
  }

  return { data: result.data as z.output<T> } as const;
}

// Maps an RPC error to an HTTP response without leaking internal details.
// Messages are only passed through for RAISE EXCEPTION errors (P0001), which the
// database functions author deliberately for the caller.
export function rpcErrorResponse(
  error: PostgrestError,
  context: string,
  fallbackMessage: string,
) {
  console.error(`${context}:`, error.code, error.message);

  const notFound = /not found|does not exist/i.test(error.message);
  // Business-rule failures: stock, points, availability, order state.
  const conflict =
    /insufficient|out of stock|not available|unavailable|already|cannot be cancel|not eligible|not allowed/i.test(
      error.message,
    );

  if (error.code === "P0002" || (error.code === "P0001" && notFound)) {
    return errorResponse(
      error.code === "P0001" ? error.message : "Resource not found",
      404,
    );
  }

  if (error.code === "42501") {
    return errorResponse("An active customer account is required", 403);
  }

  if (error.code === "P0001") {
    return errorResponse(error.message, conflict ? 409 : 400);
  }

  if (error.code === "23505") {
    return errorResponse("Duplicate request", 409);
  }

  // Class 22 (data exception) and 23 (integrity constraint violation).
  if (error.code?.startsWith("22") || error.code?.startsWith("23")) {
    return errorResponse("Invalid request data", 400);
  }

  return errorResponse(fallbackMessage, 500);
}
