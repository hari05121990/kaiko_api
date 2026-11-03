import { z } from "zod";

export const FULFILMENT_TYPES = ["PICKUP", "HOME_DELIVERY"] as const;

export const orderIdSchema = z.guid("Invalid order ID");

const checkoutItemSchema = z.strictObject({
  product_id: z.guid("Invalid product ID"),
  quantity: z.number().int().min(1).max(100),
});

// Prices, points and stock are never accepted from the client:
// customer_checkout calculates and validates them in the database.
export const checkoutSchema = z
  .strictObject({
    store_id: z.guid("Invalid store ID"),
    items: z
      .array(checkoutItemSchema)
      .min(1, "At least one item is required")
      .max(50, "Too many items in one order"),
    fulfilment_type: z.enum(FULFILMENT_TYPES),
    address_id: z.guid("Invalid address ID").nullish(),
    customer_notes: z.string().trim().max(500).nullish(),
    // Matches orders.checkout_idempotency_key varchar(150).
    idempotency_key: z
      .string()
      .trim()
      .min(8)
      .max(150)
      .regex(
        /^[A-Za-z0-9_.:-]+$/,
        "Idempotency key may contain only letters, digits, _ . : -",
      ),
  })
  .superRefine((value, ctx) => {
    const productIds = value.items.map((item) => item.product_id.toLowerCase());
    if (new Set(productIds).size !== productIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Each product may appear only once; combine quantities instead",
      });
    }

    if (value.fulfilment_type === "HOME_DELIVERY" && !value.address_id) {
      ctx.addIssue({
        code: "custom",
        path: ["address_id"],
        message: "A saved address is required for HOME_DELIVERY",
      });
    }

    if (value.fulfilment_type === "PICKUP" && value.address_id) {
      ctx.addIssue({
        code: "custom",
        path: ["address_id"],
        message: "address_id must be null for PICKUP",
      });
    }
  });

export type CheckoutRequest = z.infer<typeof checkoutSchema>;

export const cancelOrderSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
});

export const orderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  status: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z_]{1,40}$/, "Invalid status")
    .optional(),
});
