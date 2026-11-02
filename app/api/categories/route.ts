import { NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";

export async function GET() {
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

    const { data, error } = await supabase
      .from("categories")
      .select("id, name, slug, description, image_path, display_order")
      .eq("status", "ACTIVE")
      .order("display_order", { ascending: true });

    if (error) {
      console.error("Categories API:", error.message);
      return NextResponse.json(
        {
          success: false,
          message: "Unable to retrieve categories",
          data: null,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Categories retrieved successfully",
      data,
    });
  } catch (error) {
    console.error("Categories API error:", error);

    return NextResponse.json(
      { success: false, message: "Internal server error", data: null },
      { status: 500 },
    );
  }
}
