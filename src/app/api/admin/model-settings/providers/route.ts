import { asc, count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { ProviderInputSchema } from "app-types/model-settings";
import { requireAdminPermission } from "auth/permissions";
import { pgDb } from "lib/db/pg/db.pg";
import {
  ModelConfigurationTable,
  ModelProviderTable,
} from "lib/db/pg/schema.pg";
import { encryptSecret, maskSecret } from "lib/model-settings/crypto";

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
  const providers = await pgDb
    .select({
      provider: ModelProviderTable,
      modelCount: count(ModelConfigurationTable.id),
    })
    .from(ModelProviderTable)
    .leftJoin(
      ModelConfigurationTable,
      eq(ModelConfigurationTable.providerId, ModelProviderTable.id),
    )
    .groupBy(ModelProviderTable.id)
    .orderBy(asc(ModelProviderTable.name));
  return NextResponse.json(
    providers.map(({ provider, modelCount }) => ({
      ...provider,
      apiKey: maskSecret(provider.encryptedApiKey),
      encryptedApiKey: undefined,
      modelCount: Number(modelCount),
    })),
  );
}

export async function POST(request: Request) {
  if (!(await authorize()))
    return new NextResponse("Unauthorized", { status: 401 });
  const parsed = ProviderInputSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const input = parsed.data;
  if (input.type !== "ollama" && !input.apiKey) {
    return NextResponse.json(
      { error: "API key is required for this provider" },
      { status: 400 },
    );
  }
  if (
    ["openai-compatible", "azure-openai", "ollama"].includes(input.type) &&
    !input.baseUrl
  ) {
    return NextResponse.json(
      { error: "Endpoint is required for this provider type" },
      { status: 400 },
    );
  }
  const [provider] = await pgDb
    .insert(ModelProviderTable)
    .values({
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl || null,
      encryptedApiKey: input.apiKey ? encryptSecret(input.apiKey) : null,
      enabled: input.enabled,
      updatedAt: new Date(),
    })
    .returning();
  return NextResponse.json(
    {
      ...provider,
      apiKey: maskSecret(provider.encryptedApiKey),
      encryptedApiKey: undefined,
    },
    { status: 201 },
  );
}
