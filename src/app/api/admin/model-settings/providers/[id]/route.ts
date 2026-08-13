import { ProviderInputSchema } from "app-types/model-settings";
import { requireAdminPermission } from "auth/permissions";
import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  ModelConfigurationTable,
  ModelProviderTable,
} from "lib/db/pg/schema.pg";
import { encryptSecret } from "lib/model-settings/crypto";
import { NextResponse } from "next/server";

async function authorize() {
  try {
    await requireAdminPermission();
    return true;
  } catch {
    return false;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await authorize()))
    return new NextResponse("Unauthorized", { status: 401 });
  const parsed = ProviderInputSchema.partial().safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const input = parsed.data;
  const { id } = await params;
  const [provider] = await pgDb
    .update(ModelProviderTable)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl || null }),
      ...(input.apiKey ? { encryptedApiKey: encryptSecret(input.apiKey) } : {}),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      updatedAt: new Date(),
    })
    .where(eq(ModelProviderTable.id, id))
    .returning();
  if (!provider) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json({
    ...provider,
    encryptedApiKey: undefined,
    apiKey: provider.encryptedApiKey ? "••••" : null,
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await authorize()))
    return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await params;
  const [model] = await pgDb
    .select({ id: ModelConfigurationTable.id })
    .from(ModelConfigurationTable)
    .where(eq(ModelConfigurationTable.providerId, id))
    .limit(1);
  if (model)
    return NextResponse.json(
      { error: "Delete this provider's models first" },
      { status: 409 },
    );
  await pgDb.delete(ModelProviderTable).where(eq(ModelProviderTable.id, id));
  return new NextResponse(null, { status: 204 });
}
