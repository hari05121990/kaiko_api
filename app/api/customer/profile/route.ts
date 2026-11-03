import { unstable_rethrow } from "next/navigation";
import { parseBody, requireUser, rpcErrorResponse } from "@/lib/customer/api";
import { updateProfileSchema } from "@/lib/customer/schemas";
import { errorResponse, successResponse } from "@/lib/utils/api-response";

export async function GET() {
  try {
    const auth = await requireUser();
    if ("response" in auth) return auth.response;

    const { data, error } = await auth.supabase.rpc("get_my_profile");

    if (error) {
      return rpcErrorResponse(error, "Get profile", "Unable to retrieve profile");
    }

    if (data == null || (Array.isArray(data) && data.length === 0)) {
      return errorResponse("Profile not found", 404);
    }

    return successResponse(data, "Profile retrieved successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Get profile API error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireUser();
    if ("response" in auth) return auth.response;

    const body = await parseBody(request, updateProfileSchema);
    if ("response" in body) return body.response;

    const { full_name, address, city, state, pincode } = body.data;

    const { data, error } = await auth.supabase.rpc("update_my_profile", {
      p_full_name: full_name,
      p_address: address,
      p_city: city,
      p_state: state,
      p_pincode: pincode,
    });

    if (error) {
      return rpcErrorResponse(error, "Update profile", "Unable to update profile");
    }

    return successResponse(data, "Profile updated successfully");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Update profile API error:", error);
    return errorResponse("Internal server error", 500);
  }
}
