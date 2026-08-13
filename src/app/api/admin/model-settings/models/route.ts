import { ModelInputSchema } from "app-types/model-settings";
import { requireAdminPermission } from "auth/permissions";
import { asc, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  ModelConfigurationTable,
  ModelProviderTable,
} from "lib/db/pg/schema.pg";
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
  const rows = await pgDb
    .select({
      model: ModelConfigurationTable,
      provider: ModelProviderTable.name,
      providerType: ModelProviderTable.type,
    })
    .from(ModelConfigurationTable)
    .innerJoin(
      ModelProviderTable,
      eq(ModelConfigurationTable.providerId, ModelProviderTable.id),
    )
    .orderBy(asc(ModelProviderTable.name), asc(ModelConfigurationTable.name));
  return NextResponse.json(
    rows.map(({ model, provider, providerType }) => ({
      ...model,
      provider,
      providerType,
    })),
  );
}

export async function POST(request: Request) {
  if (!(await authorize()))
    return new NextResponse("Unauthorized", { status: 401 });
  const parsed = ModelInputSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const input = parsed.data;
  const [provider] = await pgDb
    .select()
    .from(ModelProviderTable)
    .where(eq(ModelProviderTable.id, input.providerId))
    .limit(1);
  if (!provider)
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  if (provider.type === "azure-openai" && !input.apiVersion)
    return NextResponse.json(
      { error: "Azure OpenAI requires an API version" },
      { status: 400 },
    );
  if (input.isDefault)
    await pgDb
      .update(ModelConfigurationTable)
      .set({ isDefault: false, updatedAt: new Date() });
  const [model] = await pgDb
    .insert(ModelConfigurationTable)
    .values({
      providerId: input.providerId,
      name: input.name,
      apiModelId: input.apiModelId,
      apiVersion: input.apiVersion || null,
      contextWindow: input.contextWindow,
      capabilities: input.capabilities,
      enabled: input.enabled,
      isDefault: input.isDefault,
      updatedAt: new Date(),
    })
    .returning();
  return NextResponse.json(model, { status: 201 });
}
