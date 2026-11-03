import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { requireUser, validationMessage } from "@/lib/customer/api";
import { errorResponse } from "@/lib/utils/api-response";

const GLOBAL_ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];
const STAFF_ROLES = ["SUPER_ADMIN", "ADMIN", "STAFF"];

// Resolves the caller's staff/admin scope from their own profile and role rows.
// Roles always come from the database, never from the request. This is an
// API-layer gate only: RLS policies and the admin RPCs re-check every operation.
// Mirrors has_global_admin_role() / can_access_store(), and additionally
// requires an ACTIVE profile (enforced in the database only from Migration 008).
//
// Allows global admins and store-level admin/staff. Use canAccessStore() or
// scope queries by storeIds for anything store-specific.
export async function requireStaff() {
  const auth = await requireUser();
  if (auth.response) return { response: auth.response } as const;

  const { supabase, user } = auth;

  const [profile, roles] = await Promise.all([
    supabase.from("profiles").select("status").eq("id", user.id).maybeSingle(),
    supabase.from("user_roles").select("role, store_id").eq("user_id", user.id),
  ]);

  if (profile.error || roles.error) {
    const error = profile.error ?? roles.error;
    console.error("Admin permission lookup:", error?.code, error?.message);
    return { response: errorResponse("Unable to verify permissions", 500) } as const;
  }

  const staffRoles = (roles.data ?? []).filter((row) =>
    STAFF_ROLES.includes(row.role),
  );

  if (profile.data?.status !== "ACTIVE" || staffRoles.length === 0) {
    return {
      response: errorResponse("Staff or administrator access is required", 403),
    } as const;
  }

  const isGlobalAdmin = staffRoles.some(
    (row) => GLOBAL_ADMIN_ROLES.includes(row.role) && row.store_id === null,
  );

  // Stores a store-level admin/staff member is assigned to. Global admins can
  // access every store, so their list is not used for scoping.
  const storeIds = [
    ...new Set(
      staffRoles
        .map((row) => row.store_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (!isGlobalAdmin && storeIds.length === 0) {
    return {
      response: errorResponse("Staff or administrator access is required", 403),
    } as const;
  }

  return { supabase, user, isGlobalAdmin, storeIds } as const;
}

export type StaffAuth = Exclude<
  Awaited<ReturnType<typeof requireStaff>>,
  { response: unknown }
>;

// Global SUPER_ADMIN / ADMIN only (role row with no store_id).
export async function requireGlobalAdmin() {
  const auth = await requireStaff();
  if (auth.response) return { response: auth.response } as const;

  if (!auth.isGlobalAdmin) {
    return { response: errorResponse("Administrator access is required", 403) } as const;
  }

  return auth;
}

export function canAccessStore(auth: StaffAuth, storeId: string) {
  return auth.isGlobalAdmin || auth.storeIds.includes(storeId.toLowerCase());
}

// Returns null when the target holds the CUSTOMER role, otherwise a 404.
// Requires a global admin client (user_roles RLS hides other users' rows).
export async function requireCustomerAccount(
  supabase: SupabaseClient,
  customerId: string,
) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("id")
    .eq("user_id", customerId)
    .eq("role", "CUSTOMER")
    .limit(1);

  if (error) {
    console.error("Customer role lookup:", error.code, error.message);
    return errorResponse("Unable to verify customer", 500);
  }

  return data.length ? null : errorResponse("Customer not found", 404);
}

// Reward mutations must target another account holding the CUSTOMER role.
// Migration 008 (G1) adds the same checks inside the reward RPCs; until it is
// applied this is the only place they are enforced.
export async function requireRewardTarget(auth: StaffAuth, customerId: string) {
  if (customerId === auth.user.id) {
    return errorResponse("Administrators cannot change reward points on their own account", 403);
  }

  return requireCustomerAccount(auth.supabase, customerId);
}

// Parses URL search params against a schema. Empty values count as missing.
export function parseQuery<T extends z.ZodType>(request: NextRequest, schema: T) {
  const raw = Object.fromEntries(
    [...request.nextUrl.searchParams].filter(([, value]) => value !== ""),
  );

  const result = schema.safeParse(raw);
  if (!result.success) {
    return { response: errorResponse(validationMessage(result.error), 400) } as const;
  }

  return { data: result.data as z.output<T> } as const;
}

export function pageRange(page: number, limit: number) {
  const from = (page - 1) * limit;
  return [from, from + limit - 1] as const;
}

export function pagination(page: number, limit: number, count: number | null) {
  const total = count ?? 0;
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

// Strips PostgREST filter punctuation and LIKE wildcards from free-text search.
export function searchPattern(search: string) {
  return `%${search.replace(/[\\%_(),.*]/g, " ")}%`;
}

// Awaits a head/count query (select(..., { count: "exact", head: true })).
// Only the count is transferred, never the rows.
export async function countRows(
  query: PromiseLike<{ count: number | null; error: PostgrestError | null }>,
) {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

// RPCs returning TABLE(...) come back as arrays; admin endpoints return one row.
export function firstRow<T>(data: T[] | T | null): T | null {
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

// Maps a database / PostgREST error to an HTTP response without leaking
// internals. RAISE EXCEPTION messages (P0001/P0002 and RPC-authored 23505/42501)
// are written for the caller and passed through.
export function adminErrorResponse(
  error: PostgrestError,
  context: string,
  fallbackMessage: string,
) {
  console.error(`${context}:`, error.code, error.message);

  const message = error.message ?? "";
  const details = error.details ?? "";

  // The RPC is not deployed (e.g. Migration 008 not applied yet).
  if (error.code === "PGRST202") {
    return errorResponse(
      "This operation depends on a database function that is not installed yet",
      501,
    );
  }

  // Single-row request matched nothing (.single()).
  if (error.code === "PGRST116") {
    return errorResponse("Resource not found", 404);
  }

  // Insufficient privilege, including RLS write rejections.
  if (error.code === "42501") {
    const authored = !/row-level security|permission denied/i.test(message);
    return errorResponse(
      authored ? message : "You do not have permission to perform this action",
      403,
    );
  }

  if (error.code === "P0002") {
    return errorResponse(message || "Resource not found", 404);
  }

  if (error.code === "P0001") {
    if (/not authori[sz]ed|cannot .* (their|on their) own account/i.test(message)) {
      return errorResponse(message, 403);
    }
    if (/not found|does not exist/i.test(message)) {
      return errorResponse(message, 404);
    }
    const conflict =
      /insufficient|already|not allowed|no longer|cannot reverse|idempotency key/i.test(
        message,
      );
    return errorResponse(message, conflict ? 409 : 400);
  }

  if (error.code === "23505") {
    // Constraint violations carry "Key (column)=(value) already exists." in details.
    if (/^duplicate key/i.test(message)) {
      const column = details.match(/Key \(([^)]+)\)/)?.[1];
      return errorResponse(
        column ? `${column} already exists` : "Duplicate record",
        409,
      );
    }
    return errorResponse(message, 409);
  }

  if (error.code === "23503") {
    if (/still referenced/i.test(details)) {
      const table = details.match(/from table "([^"]+)"/)?.[1];
      return errorResponse(
        table ? `Record is still referenced by ${table}` : "Record is still in use",
        409,
      );
    }
    const column = details.match(/Key \(([^)]+)\)/)?.[1];
    return errorResponse(
      column
        ? `${column}: referenced record does not exist`
        : "Referenced record does not exist",
      400,
    );
  }

  // Class 22 (data exception) and 23 (other integrity constraint violations).
  if (error.code?.startsWith("22") || error.code?.startsWith("23")) {
    return errorResponse("Invalid request data", 400);
  }

  return errorResponse(fallbackMessage, 500);
}
