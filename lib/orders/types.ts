// Customer-facing order shapes. Internal columns (admin_notes,
// checkout_idempotency_key, cancelled_by, return_confirmed_by) are never selected.

export interface OrderStore {
  id: string;
  store_name: string;
  city: string | null;
}

export interface OrderSummary {
  id: string;
  order_number: string;
  store_id: string;
  fulfilment_type: string;
  order_status: string;
  delivery_status: string;
  total_amount: number;
  total_points: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  store: OrderStore | null;
}

export interface OrderItem {
  id: string;
  product_id: string | null;
  product_name: string;
  sku: string | null;
  quantity: number;
  unit_price: number;
  points_per_unit: number;
  total_price: number;
  total_points: number;
}

export interface OrderStatusChange {
  old_status: string | null;
  new_status: string;
  remarks: string | null;
  created_at: string;
}

export interface OrderDetails extends OrderSummary {
  delivery_address: Record<string, unknown> | null;
  customer_notes: string | null;
  cancellation_reason: string | null;
  items: OrderItem[];
  status_history: OrderStatusChange[];
}

export const ORDER_SUMMARY_COLUMNS = `
  id,
  order_number,
  store_id,
  fulfilment_type,
  order_status,
  delivery_status,
  total_amount,
  total_points,
  created_at,
  updated_at,
  cancelled_at,
  store:stores ( id, store_name, city )
`;

export const ORDER_DETAIL_COLUMNS = `
  ${ORDER_SUMMARY_COLUMNS},
  delivery_address,
  customer_notes,
  cancellation_reason,
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
  ),
  status_history:order_status_history (
    old_status,
    new_status,
    remarks,
    created_at
  )
`;
