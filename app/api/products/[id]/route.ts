import { NextRequest, NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!uuidRegex.test(id)) {
      return NextResponse.json(
        { success: false, message: "Invalid product ID", data: null },
        { status: 400 },
      );
    }

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

    const { data, error } = await supabase
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
        categories (
          id,
          name,
          slug
        ),
        product_images (
          id,
          image_path,
          alt_text,
          display_order
        ),
        store_products (
          store_id,
          stock_quantity,
          is_available,
          stores (
            id,
            store_name,
            city,
            status
          )
        )
      `,
      )
      .eq("id", id)
      .eq("status", "ACTIVE")
      .maybeSingle();

    if (error) {
      console.error("Product details API:", error.message);

      return NextResponse.json(
        { success: false, message: "Unable to retrieve product", data: null },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json(
        { success: false, message: "Product not found", data: null },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Product retrieved successfully",
      data,
    });
  } catch (error) {
    console.error("Product details API error:", error);

    return NextResponse.json(
      { success: false, message: "Internal server error", data: null },
      { status: 500 },
    );
  }
}
