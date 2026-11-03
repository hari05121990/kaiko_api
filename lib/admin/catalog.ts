// Columns returned by the admin catalog and store endpoints.

export const ADMIN_PRODUCT_COLUMNS = `
  id,
  category_id,
  name,
  slug,
  description,
  sku,
  price,
  points_required,
  status,
  is_featured,
  created_at,
  updated_at
`;

export const PRODUCT_IMAGE_COLUMNS = "id, product_id, image_path, alt_text, display_order, created_at";

export const ADMIN_CATEGORY_COLUMNS =
  "id, name, slug, description, image_path, status, display_order, created_at, updated_at";

export const ADMIN_STORE_COLUMNS =
  "id, store_code, store_name, address, city, state, pincode, mobile, email, status, created_at, updated_at";
