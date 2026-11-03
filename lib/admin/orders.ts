import type { StaffAuth } from "@/lib/admin/api";
import { ORDER_SUMMARY_COLUMNS } from "@/lib/orders/types";

// Admin views add customer and back-office columns to the customer-facing
// shapes. checkout_idempotency_key stays internal.
export const ADMIN_ORDER_SUMMARY_COLUMNS = `
  ${ORDER_SUMMARY_COLUMNS},
  customer_id
`;

export const ADMIN_ORDER_DETAIL_COLUMNS = `
  ${ADMIN_ORDER_SUMMARY_COLUMNS},
  delivery_address,
  customer_notes,
  admin_notes,
  cancellation_reason,
  cancelled_by,
  return_confirmed_by,
  return_confirmed_at,
  items:order_items (
    id,
    product_id,
    product_name,
    sku,
    quantity,
    unit_price,
    points_per_unit,
    total_price,
    total_points
  )
`;

// Loads an order the caller may manage. RLS (orders_read) would also return
// the caller's own customer orders, so non-global staff are explicitly limited
// to their stores. Out-of-scope orders are indistinguishable from missing ones.
export async function findScopedOrder(auth: StaffAuth, id: string, columns = "id") {
  let query = auth.supabase.from("orders").select(columns).eq("id", id);

  if (!auth.isGlobalAdmin) {
    query = query.in("store_id", auth.storeIds);
  }

  return query.maybeSingle();
}
