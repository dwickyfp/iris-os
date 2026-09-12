import {
  SystemSettingKeySchema,
  SystemSettingMutationSchema,
} from "app-types/system-settings";
import { requireAdminActor } from "auth/permissions";
import { systemSettingsService } from "lib/system-settings/server";
import { SystemSettingRevisionConflictError } from "lib/system-settings/service";
import { z } from "zod";

const NO_STORE = { "Cache-Control": "private, no-store" };
const RequestSchema = z
  .object({
    operation: z.enum(["set", "clear"]).optional(),
    value: z.unknown().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    revision: z.number().int().nonnegative().optional(),
  })
  .refine(
    ({ expectedRevision, revision }) =>
      expectedRevision !== undefined || revision !== undefined,
    { message: "Expected revision is required" },
  );

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  let actor: { id: string };
  try {
    actor = await requireAdminActor();
  } catch {
    return error("Forbidden", 403);
  }

  const key = SystemSettingKeySchema.safeParse((await params).key);
  if (!key.success) return error("Unknown system setting", 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON request body", 400);
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return error(parsed.error.issues[0]?.message ?? "Invalid request", 400);
  }
  const operation =
    parsed.data.operation ?? (parsed.data.value === null ? "clear" : "set");
  const mutation = SystemSettingMutationSchema.safeParse(
    operation === "clear"
      ? { operation, key: key.data }
      : { operation, key: key.data, value: parsed.data.value },
  );
  if (!mutation.success) {
    return error(mutation.error.issues[0]?.message ?? "Invalid value", 400);
  }

  try {
    const updated = await systemSettingsService.mutate(
      mutation.data,
      actor.id,
      parsed.data.expectedRevision ?? parsed.data.revision ?? 0,
    );
    if (!updated.restartRequired) {
      const { refreshRuntimeSystemSettings } = await import(
        "lib/system-settings/runtime"
      );
      await refreshRuntimeSystemSettings();
    }
    return Response.json(updated, { headers: NO_STORE });
  } catch (cause) {
    if (cause instanceof SystemSettingRevisionConflictError) {
      return error(cause.message, 409);
    }
    if (cause instanceof z.ZodError) {
      return error(cause.issues[0]?.message ?? "Invalid value", 400);
    }
    return error("System setting update failed", 500);
  }
}
