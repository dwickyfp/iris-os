import { requireAdminActor } from "auth/permissions";
import { pgDb } from "lib/db/pg/db.pg";
import { ModelProviderTable } from "lib/db/pg/schema.pg";
import { SYSTEM_SETTING_DEFINITIONS } from "lib/system-settings/definitions";
import { systemSettingsService } from "lib/system-settings/server";

const NO_STORE = { "Cache-Control": "private, no-store" };

const GROUP_LABELS: Record<string, string> = {
  exa: "Exa Search",
  mcp: "MCP",
  providers: "Providers",
};

function title(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export async function GET() {
  try {
    await requireAdminActor();
  } catch {
    return Response.json(
      { error: "Forbidden" },
      { status: 403, headers: NO_STORE },
    );
  }

  let settings: Awaited<ReturnType<typeof systemSettingsService.list>>;
  try {
    settings = await systemSettingsService.list();
  } catch {
    return Response.json(
      { error: "System settings unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      settings: Array<Record<string, unknown>>;
    }
  >();
  const providers = await pgDb
    .select({ id: ModelProviderTable.id, name: ModelProviderTable.name })
    .from(ModelProviderTable);
  for (const setting of settings) {
    const groupKey = setting.key.split(".")[0];
    const definition = SYSTEM_SETTING_DEFINITIONS[setting.key];
    const providerOptions = setting.key.startsWith("providers.")
      ? providers.map((provider) => ({
          label: provider.name,
          value: provider.id,
        }))
      : undefined;
    const type =
      definition.sensitivity === "secret"
        ? "password"
        : providerOptions
          ? "select"
          : typeof definition.default === "boolean"
            ? "boolean"
            : "text";
    const group = groups.get(groupKey) ?? {
      key: groupKey,
      label: GROUP_LABELS[groupKey] ?? title(groupKey),
      settings: [],
    };
    group.settings.push({
      key: setting.key,
      label: title(setting.key.split(".").slice(1).join(" ")),
      type,
      value: setting.value,
      revision: setting.revision,
      secretConfigured: setting.sensitivity === "secret" && setting.configured,
      ...(providerOptions ? { options: providerOptions } : {}),
    });
    groups.set(groupKey, group);
  }

  return Response.json({ groups: [...groups.values()] }, { headers: NO_STORE });
}
