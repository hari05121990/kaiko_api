import { z } from "zod";

// Lengths mirror the varchar limits on the underlying tables.
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
// For updates: null or "" clears the column.
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => value || null);

const pincode = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, "Pincode must be a 6-digit Indian pincode");

const mobile = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{10,15}$/, "Mobile must be 10-15 digits, optionally prefixed with +");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(150)
  .pipe(z.email("Invalid email address"));

// Rupee amounts with at most two decimal places.
const amount = z
  .number()
  .min(0)
  .max(10_000_000)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
    "Amount must have at most 2 decimal places",
  );

const slug = (max: number) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .max(max)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug may contain only lowercase letters, digits and single hyphens",
    );

// Storage object path or an https URL; no other URL schemes.
const imagePath = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (value) => /^https:\/\//i.test(value) || !value.includes(":"),
    "Image path must be a storage path or an https URL",
  );

const uuid = (label: string) => z.guid(`Invalid ${label}`).toLowerCase();

const atLeastOneField = (value: object) => Object.keys(value).length > 0;
const AT_LEAST_ONE_FIELD = "At least one field must be provided";

export const idSchema = z.guid();

// Matches reward_transactions.idempotency_key varchar(150).
export const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(150)
  .regex(
    /^[A-Za-z0-9_.:-]+$/,
    "Idempotency key may contain only letters, digits, _ . : -",
  );

const pageQuery = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

const search = z.string().trim().max(100);
const booleanParam = z.enum(["true", "false"]).transform((value) => value === "true");
const isoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const dateRangeQuery = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};

// Date-only bounds are inclusive whole days in UTC.
export function toTimestampRange(from?: string, to?: string) {
  const start = from && (from.length === 10 ? `${from}T00:00:00.000Z` : from);
  const end = to && (to.length === 10 ? `${to}T23:59:59.999Z` : to);

  if (start && end && Date.parse(start) > Date.parse(end)) {
    return { error: "from must not be after to" } as const;
  }

  return { start, end } as const;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE", "BLOCKED"] as const;

export const createCustomerSchema = z.strictObject({
  full_name: text(150),
  mobile,
  email,
  // Initial Auth password; never stored or logged by the API.
  password: z.string().min(8).max(72),
  address: optionalText(500),
  city: optionalText(100),
  state: optionalText(100),
  pincode: pincode.optional(),
});

// Email, role, status and wallet are not editable here.
export const updateCustomerSchema = z
  .strictObject({
    full_name: text(150).optional(),
    mobile: mobile.optional(),
    address: clearableText(500).optional(),
    city: clearableText(100).optional(),
    state: clearableText(100).optional(),
    pincode: pincode.nullable().optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);

export const customerStatusSchema = z.strictObject({
  status: z.enum(CUSTOMER_STATUSES),
  reason: text(500),
});

export const customerListQuerySchema = z.object({
  ...pageQuery,
  q: search.optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
});

export const REWARD_TRANSACTION_TYPES = [
  "CREDIT",
  "DEBIT",
  "REVERSAL",
  "ADJUSTMENT",
] as const;

export const customerRewardsQuerySchema = z.object({
  ...pageQuery,
  type: z.enum(REWARD_TRANSACTION_TYPES).optional(),
});

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

// Points are never accepted for purchase credits: admin_credit_points derives
// them from the purchase amount.
export const creditPointsSchema = z.strictObject({
  customer_id: uuid("customer ID"),
  purchase_amount: amount.refine((value) => value > 0, "Purchase amount must be greater than zero"),
  reference_id: uuid("reference ID").optional(),
  description: optionalText(500),
  idempotency_key: idempotencyKey,
});

export const adjustPointsSchema = z.strictObject({
  customer_id: uuid("customer ID"),
  direction: z.enum(["CREDIT", "DEBIT"]),
  points: z.number().int().min(1).max(1_000_000),
  reason: text(500),
  idempotency_key: idempotencyKey,
});

export const reversePointsSchema = z.strictObject({
  transaction_id: uuid("transaction ID"),
  reason: text(500),
  idempotency_key: idempotencyKey,
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "READY_FOR_PICKUP",
  "OUT_FOR_DELIVERY",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
] as const;

// Targets accepted by admin_update_order_status. CANCELLED goes through
// cancel_order; transition rules are enforced in the database.
export const ADMIN_ORDER_TARGET_STATUSES = [
  "CONFIRMED",
  "READY_FOR_PICKUP",
  "OUT_FOR_DELIVERY",
  "COMPLETED",
] as const;

export const FULFILMENT_TYPES = ["PICKUP", "HOME_DELIVERY"] as const;

export const adminOrderListQuerySchema = z.object({
  ...pageQuery,
  ...dateRangeQuery,
  status: z.enum(ORDER_STATUSES).optional(),
  fulfilment_type: z.enum(FULFILMENT_TYPES).optional(),
  store_id: uuid("store ID").optional(),
  customer_id: uuid("customer ID").optional(),
  q: search.optional(),
});

export const updateOrderStatusSchema = z.strictObject({
  status: z.enum(ADMIN_ORDER_TARGET_STATUSES),
  remarks: optionalText(500),
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const PRODUCT_STATUSES = ["ACTIVE", "INACTIVE", "DRAFT"] as const;
export const CATEGORY_STATUSES = ["ACTIVE", "INACTIVE"] as const;

const productFields = {
  category_id: uuid("category ID").nullable(),
  name: text(200),
  slug: slug(220),
  description: clearableText(5000),
  sku: clearableText(80),
  price: amount,
  points_required: z.number().int().min(0).max(100_000_000).nullable(),
  is_featured: z.boolean(),
};

export const createProductSchema = z.strictObject({
  ...productFields,
  slug: productFields.slug.optional(),
  category_id: productFields.category_id.optional(),
  description: productFields.description.optional(),
  sku: productFields.sku.optional(),
  points_required: productFields.points_required.optional(),
  is_featured: productFields.is_featured.optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
});

// Status changes go through PATCH /api/admin/products/[id]/status.
export const updateProductSchema = z
  .strictObject(productFields)
  .partial()
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);

export const productStatusSchema = z.strictObject({
  status: z.enum(PRODUCT_STATUSES),
});

export const productImageSchema = z.strictObject({
  image_path: imagePath,
  alt_text: optionalText(200),
  display_order: z.number().int().min(0).max(1000).optional(),
});

const categoryFields = {
  name: text(100),
  slug: slug(120),
  description: clearableText(2000),
  image_path: imagePath.nullable(),
  status: z.enum(CATEGORY_STATUSES),
  display_order: z.number().int().min(0).max(10000),
};

export const createCategorySchema = z
  .strictObject(categoryFields)
  .partial()
  .required({ name: true });

export const updateCategorySchema = z
  .strictObject(categoryFields)
  .partial()
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);

// ---------------------------------------------------------------------------
// Stores and inventory
// ---------------------------------------------------------------------------

export const STORE_STATUSES = ["ACTIVE", "INACTIVE"] as const;

const storeFields = {
  store_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,30}$/, "Store code must be 2-30 letters, digits, _ or -"),
  store_name: text(150),
  address: clearableText(500),
  city: clearableText(100),
  state: clearableText(100),
  pincode: pincode.nullable(),
  mobile: mobile.nullable(),
  email: email.nullable(),
  status: z.enum(STORE_STATUSES),
};

export const createStoreSchema = z
  .strictObject(storeFields)
  .partial()
  .required({ store_code: true, store_name: true });

export const updateStoreSchema = z
  .strictObject(storeFields)
  .partial()
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);

export const storeListQuerySchema = z.object({
  ...pageQuery,
  q: search.optional(),
  status: z.enum(STORE_STATUSES).optional(),
});

export const inventoryQuerySchema = z.object({
  ...pageQuery,
  is_available: booleanParam.optional(),
  // Only rows with stock_quantity at or below this value.
  low_stock: z.coerce.number().int().min(0).max(100000).optional(),
});

export const INVENTORY_TRANSACTION_TYPES = [
  "STOCK_IN",
  "STOCK_OUT",
  "ADJUSTMENT",
  "ORDER_DEDUCTION",
  "ORDER_REVERSAL",
] as const;

// Request contract for stock adjustments. Not executable until an atomic
// inventory RPC exists (see PATCH /api/admin/stores/[id]/inventory/[productId]).
export const inventoryAdjustmentSchema = z
  .strictObject({
    transaction_type: z.enum(["STOCK_IN", "STOCK_OUT", "ADJUSTMENT"]),
    quantity_change: z
      .number()
      .int()
      .min(-100000)
      .max(100000)
      .refine((value) => value !== 0, "quantity_change must not be zero"),
    reason: text(500),
    idempotency_key: idempotencyKey,
  })
  .superRefine((value, ctx) => {
    const sign = Math.sign(value.quantity_change);
    if (
      (value.transaction_type === "STOCK_IN" && sign < 0) ||
      (value.transaction_type === "STOCK_OUT" && sign > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["quantity_change"],
        message: "quantity_change sign does not match transaction_type",
      });
    }
  });

export const inventoryTransactionQuerySchema = z.object({
  ...pageQuery,
  ...dateRangeQuery,
  store_id: uuid("store ID").optional(),
  product_id: uuid("product ID").optional(),
  transaction_type: z.enum(INVENTORY_TRANSACTION_TYPES).optional(),
});

// ---------------------------------------------------------------------------
// Dashboard, reports, audit logs
// ---------------------------------------------------------------------------

export const dashboardQuerySchema = z.object({
  store_id: uuid("store ID").optional(),
  low_stock: z.coerce.number().int().min(0).max(100000).default(5),
});

export const reportQuerySchema = z.object({
  ...dateRangeQuery,
  store_id: uuid("store ID").optional(),
});

export const auditLogQuerySchema = z.object({
  ...pageQuery,
  ...dateRangeQuery,
  action: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z_]{1,100}$/, "Invalid action")
    .optional(),
  entity_type: z.string().trim().max(100).optional(),
  entity_id: uuid("entity ID").optional(),
  admin_id: uuid("admin ID").optional(),
});
