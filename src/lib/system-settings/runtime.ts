import type { SystemSettingKey, SystemSettingScalar } from "app-types/system-settings";
import { SYSTEM_SETTING_DEFINITIONS } from "./definitions";

const values = new Map<SystemSettingKey, SystemSettingScalar>();
let refreshPromise: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

export function runtimeSystemSetting(key: SystemSettingKey): SystemSettingScalar {
  return values.has(key) ? values.get(key)! : SYSTEM_SETTING_DEFINITIONS[key].default;
}

export async function refreshRuntimeSystemSettings() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = import("./server").then(({ systemSettingsService }) =>
    Promise.all(
      (Object.keys(SYSTEM_SETTING_DEFINITIONS) as SystemSettingKey[])
        .filter((key) => SYSTEM_SETTING_DEFINITIONS[key].sensitivity === "public")
        .map(
          async (key) =>
            [key, await systemSettingsService.getPlain(key)] as const,
        ),
    ),
  )
    .then((entries) => {
      for (const [key, value] of entries) values.set(key, value);
    })
    .finally(() => {
      refreshPromise = undefined;
    });
  return refreshPromise;
}

export async function startRuntimeSystemSettingsRefresh(intervalMs = 5_000) {
  await refreshRuntimeSystemSettings();
  if (timer) return;
  timer = setInterval(() => void refreshRuntimeSystemSettings(), intervalMs);
  timer.unref?.();
}
