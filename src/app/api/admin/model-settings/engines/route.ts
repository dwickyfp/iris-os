import { SystemModelEngineAssignmentSchema } from "app-types/model-settings";
import { requireAdminPermission } from "auth/permissions";
import { eq } from "drizzle-orm";
import { getSystemModelEngineSettings } from "lib/ai/models";
import { pgDb } from "lib/db/pg/db.pg";
import { ModelEngineAssignmentTable } from "lib/db/pg/schema.pg";
import { NextResponse } from "next/server";

async function authorize() {
  try {
    await requireAdminPermission();
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  if (!(await authorize()))
    return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json(await getSystemModelEngineSettings());
}

export async function PATCH(request: Request) {
  if (!(await authorize()))
    return new NextResponse("Unauthorized", { status: 401 });
  const parsed = SystemModelEngineAssignmentSchema.safeParse(
    await request.json(),
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const { engineKey, modelId } = parsed.data;
  if (modelId) {
    const engine = (await getSystemModelEngineSettings()).find(
      (item) => item.key === engineKey,
    );
    if (!engine)
      return NextResponse.json({ error: "Unknown engine" }, { status: 400 });
    if (!engine.candidates.some((model) => model.id === modelId))
      return NextResponse.json(
        { error: "Model is disabled or incompatible with this engine" },
        { status: 400 },
      );
    await pgDb
      .insert(ModelEngineAssignmentTable)
      .values({ engineKey, modelId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: ModelEngineAssignmentTable.engineKey,
        set: { modelId, updatedAt: new Date() },
      });
  } else {
    await pgDb
      .delete(ModelEngineAssignmentTable)
      .where(eq(ModelEngineAssignmentTable.engineKey, engineKey));
  }
  const updated = (await getSystemModelEngineSettings()).find(
    (item) => item.key === engineKey,
  );
  return NextResponse.json(updated);
}
