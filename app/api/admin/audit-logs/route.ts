import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { pageRange, pagination, parseQuery, requireGlobalAdmin } from "@/lib/admin/api";
import { auditLogQuerySchema, toTimestampRange } from "@/lib/admin/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

// Read-only. admin_audit_logs is written only by database functions and is
// readable by global admins (RLS admin_audit_logs_read).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireGlobalAdmin();
    if ("response" in auth) return auth.response;

    const query = parseQuery(request, auditLogQuerySchema);
    if ("response" in query) return query.response;

    const { page, limit, action, entity_type, entity_id, admin_id, from, to } = query.data;

    const range = toTimestampRange(from, to);
    if (range.error) return errorResponse(range.error, 400);

    let logsQuery = auth.supabase
      .from("admin_audit_logs")
      .select(
        "id, admin_id, action, entity_type, entity_id, old_data, new_data, ip_address, created_at",
        { count: "exact" },
      );

    if (action) logsQuery = logsQuery.eq("action", action);
    if (entity_type) logsQuery = logsQuery.eq("entity_type", entity_type);
    if (entity_id) logsQuery = logsQuery.eq("entity_id", entity_id);
    if (admin_id) logsQuery = logsQuery.eq("admin_id", admin_id);
    if (range.start) logsQuery = logsQuery.gte("created_at", range.start);
    if (range.end) logsQuery = logsQuery.lte("created_at", range.end);

    const [rangeFrom, rangeTo] = pageRange(page, limit);

    const { data, error, count } = await logsQuery
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(rangeFrom, rangeTo);

    if (error) {
      console.error("Audit logs:", error.code, error.message);
      return errorResponse("Unable to retrieve audit logs", 500);
    }

    return successResponse(
      { logs: data ?? [], pagination: pagination(page, limit, count) },
      "Audit logs retrieved successfully",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("Audit logs API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
