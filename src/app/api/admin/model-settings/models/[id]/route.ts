import { ModelInputSchema } from "app-types/model-settings";
import { requireAdminPermission } from "auth/permissions";
import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { ModelConfigurationTable } from "lib/db/pg/schema.pg";
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
  const parsed = ModelInputSchema.partial().safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const input = parsed.data;
  const { id } = await params;
  if (input.isDefault)
    await pgDb
      .update(ModelConfigurationTable)
      .set({ isDefault: false, updatedAt: new Date() });
  const [model] = await pgDb
    .update(ModelConfigurationTable)
    .set({
      ...(input.providerId && { providerId: input.providerId }),
      ...(input.name && { name: input.name }),
      ...(input.apiModelId && { apiModelId: input.apiModelId }),
      ...(input.apiVersion !== undefined && {
        apiVersion: input.apiVersion || null,
      }),
      ...(input.contextWindow && { contextWindow: input.contextWindow }),
      ...(input.capabilities && { capabilities: input.capabilities }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
      updatedAt: new Date(),
    })
    .where(eq(ModelConfigurationTable.id, id))
    .returning();
  if (!model) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(model);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await authorize()))
    return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await params;
  await pgDb
    .delete(ModelConfigurationTable)
    .where(eq(ModelConfigurationTable.id, id));
  return new NextResponse(null, { status: 204 });
}
