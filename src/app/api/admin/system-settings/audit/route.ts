import { SystemSettingKeySchema } from "app-types/system-settings";
import { requireAdminActor } from "auth/permissions";
import { systemSettingsService } from "lib/system-settings/server";
import { z } from "zod";

const NO_STORE = { "Cache-Control": "private, no-store" };
const QuerySchema = z.object({
  key: SystemSettingKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function GET(request: Request) {
  try {
    await requireAdminActor();
  } catch {
    return Response.json(
      { error: "Forbidden" },
      { status: 403, headers: NO_STORE },
    );
  }

  const url = new URL(request.url);
  const query = QuerySchema.safeParse({
    key: url.searchParams.get("key") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!query.success) {
    return Response.json(
      { error: query.error.issues[0]?.message ?? "Invalid query" },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    return Response.json(
      { audit: await systemSettingsService.listAudit(query.data) },
      { headers: NO_STORE },
    );
  } catch {
    return Response.json(
      { error: "System setting audit unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}
