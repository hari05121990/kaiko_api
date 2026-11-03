import { z } from "zod";

// Lengths mirror the varchar limits on profiles / customer_addresses.
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

const pincode = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, "Pincode must be a 6-digit Indian pincode");

const mobile = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{10,15}$/, "Mobile must be 10-15 digits, optionally prefixed with +");

export const addressIdSchema = z.guid("Invalid address ID");

// Strict objects reject unknown keys, so protected fields such as mobile,
// email, role or status cannot be smuggled into a profile update.
export const updateProfileSchema = z.strictObject({
  full_name: text(150),
  address: optionalText(500),
  city: optionalText(100),
  state: optionalText(100),
  pincode: pincode.optional(),
});

const addressFields = {
  recipient_name: text(150),
  mobile,
  address_line1: text(500),
  address_line2: optionalText(500),
  landmark: optionalText(200),
  city: text(100),
  state: text(100),
  pincode,
  address_name: optionalText(50),
};

export const createAddressSchema = z.strictObject({
  ...addressFields,
  is_default: z.boolean().optional(),
});

// update_my_address requires the full address, so PATCH does too.
// Use PATCH /api/customer/addresses/[id]/default to change the default address.
export const updateAddressSchema = z.strictObject(addressFields);

export const rewardHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type AddressInput = z.infer<typeof updateAddressSchema>;

// Maps validated address fields to the add/update_my_address RPC arguments.
// Omitted optional fields are left out so the database defaults apply.
export function toAddressRpcArgs(input: AddressInput) {
  return {
    p_recipient_name: input.recipient_name,
    p_mobile: input.mobile,
    p_address_line1: input.address_line1,
    p_address_line2: input.address_line2,
    p_landmark: input.landmark,
    p_city: input.city,
    p_state: input.state,
    p_pincode: input.pincode,
    p_address_name: input.address_name,
  };
}
