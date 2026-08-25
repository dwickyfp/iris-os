import "server-only";

import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { ModelProviderTable } from "lib/db/pg/schema.pg";
import { decryptSecret } from "lib/model-settings/crypto";
import { systemSettingsService } from "lib/system-settings/server";

export async function resolveConfiguredProviderCredential(
  setting: "providers.imageProviderId" | "providers.realtimeProviderId",
) {
  const providerId = await systemSettingsService.getPlain(setting);
  if (typeof providerId !== "string")
    throw new Error(`${setting} is not configured`);
  const [provider] = await pgDb
    .select()
    .from(ModelProviderTable)
    .where(eq(ModelProviderTable.id, providerId));
  if (!provider?.enabled || !provider.encryptedApiKey)
    throw new Error("Configured provider credential is unavailable");
  return {
    provider,
    apiKey: await decryptSecret(provider.encryptedApiKey),
  };
}
