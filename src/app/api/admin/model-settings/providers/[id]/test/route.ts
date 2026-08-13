import { requireAdminPermission } from "auth/permissions";
import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { ModelProviderTable } from "lib/db/pg/schema.pg";
import { decryptSecret } from "lib/model-settings/crypto";
import { NextResponse } from "next/server";

const defaultEndpoints: Record<string, string> = {
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  xai: "https://api.x.ai/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
};

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdminPermission();
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { id } = await params;
  const [provider] = await pgDb
    .select()
    .from(ModelProviderTable)
    .where(eq(ModelProviderTable.id, id))
    .limit(1);
  if (!provider) return new NextResponse("Not found", { status: 404 });
  const endpoint = provider.baseUrl
    ? `${provider.baseUrl.replace(/\/$/, "")}/models`
    : defaultEndpoints[provider.type];
  if (!endpoint)
    return NextResponse.json(
      {
        ok: false,
        message: "Configure an endpoint before testing this provider",
      },
      { status: 400 },
    );
  try {
    const apiKey = provider.encryptedApiKey
      ? decryptSecret(provider.encryptedApiKey)
      : undefined;
    const response = await fetch(endpoint, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const ok = response.ok;
    const message = ok
      ? "Connection successful"
      : `Provider returned ${response.status}`;
    await pgDb
      .update(ModelProviderTable)
      .set({
        lastConnectionStatus: ok ? "connected" : "error",
        lastConnectionError: ok ? null : message,
        updatedAt: new Date(),
      })
      .where(eq(ModelProviderTable.id, id));
    return NextResponse.json({ ok, message }, { status: ok ? 200 : 400 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Connection failed";
    await pgDb
      .update(ModelProviderTable)
      .set({
        lastConnectionStatus: "error",
        lastConnectionError: message,
        updatedAt: new Date(),
      })
      .where(eq(ModelProviderTable.id, id));
    return NextResponse.json({ ok: false, message }, { status: 400 });
  }
}
