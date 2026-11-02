import { NextRequest, NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";

const ALLOWED_SORT_FIELDS = ["name", "price", "created_at"] as const;

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await getAuthUser(supabase);

    if (authError || !user) {
      return NextResponse.json(
        { success: false, message: "Authentication required", data: null },
        { status: 401 },
      );
    }

    const params = request.nextUrl.searchParams;

    const page = Math.max(1, Number(params.get("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 20));

    const categoryId = params.get("category_id");
    const search = params.get("q")?.trim();
    const sort = params.get("sort") || "created_at";
    const order = params.get("order") || "desc";
    const storeId = params.get("store_id");

    if (
      !ALLOWED_SORT_FIELDS.includes(
        sort as (typeof ALLOWED_SORT_FIELDS)[number],
      )
    ) {
      return NextResponse.json(
        { success: false, message: "Invalid sort field", data: null },
        { status: 400 },
      );
    }

    if (!["asc", "desc"].includes(order)) {
      return NextResponse.json(
        { success: false, message: "Invalid sort order", data: null },
        { status: 400 },
      );
    }

    if (search && search.length > 100) {
      return NextResponse.json(
        { success: false, message: "Search query is too long", data: null },
        { status: 400 },
      );
    }

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase
      .from("products")
      .select(
        `
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
          product_images (
            id,
            image_path,
            alt_text,
            display_order
          )
        `,
        { count: "exact" },
      )
      .eq("status", "ACTIVE");

    if (categoryId) {
      query = query.eq("category_id", categoryId);
    }

    if (search) {
      // Escape PostgREST filter punctuation and wildcard characters.
      const safeSearch = search.replace(/[\\%_(),.]/g, " ");
      query = query.or(`name.ilike.%${safeSearch}%,sku.ilike.%${safeSearch}%`);
    }

    const { data, error, count } = await query
      .order(sort, { ascending: order === "asc" })
      .range(from, to);

    if (error) {
      console.error("Products API:", error.message);

      return NextResponse.json(
        { success: false, message: "Unable to retrieve products", data: null },
        { status: 500 },
      );
    }

    let products = data ?? [];

    // Optional store-wise stock information
    if (storeId && products.length > 0) {
      const productIds = products.map((product) => product.id);

      const { data: inventory, error: inventoryError } = await supabase
        .from("store_products")
        .select("product_id, store_id, stock_quantity, is_available")
        .eq("store_id", storeId)
        .in("product_id", productIds);

      if (inventoryError) {
        console.error("Inventory lookup:", inventoryError.message);

        return NextResponse.json(
          {
            success: false,
            message: "Unable to retrieve inventory",
            data: null,
          },
          { status: 500 },
        );
      }

      const inventoryMap = new Map(
        (inventory ?? []).map((item) => [item.product_id, item]),
      );

      products = products.map((product) => ({
        ...product,
        inventory: inventoryMap.get(product.id) ?? null,
      }));
    }

    return NextResponse.json({
      success: true,
      message: "Products retrieved successfully",
      data: {
        products,
        pagination: {
          page,
          limit,
          total: count ?? 0,
          totalPages: Math.ceil((count ?? 0) / limit),
        },
      },
    });
  } catch (error) {
    console.error("Products API error:", error);

    return NextResponse.json(
      { success: false, message: "Internal server error", data: null },
      { status: 500 },
    );
  }
}
