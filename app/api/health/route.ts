import { successResponse } from "@/lib/utils/api-response";

export async function GET() {
  return successResponse(
    {
      application: "Kaiko Kart API",
      status: "running",
      timestamp: new Date().toISOString(),
    },
    "Kaiko Kart API is running",
  );
}
