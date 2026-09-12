"use client";

import {
  AlertCircle,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { Switch } from "ui/switch";

export type SystemSettingFieldType =
  | "text"
  | "password"
  | "boolean"
  | "number"
  | "select";

export type SystemSettingOption = {
  label: string;
  value: string;
};

export type SystemSettingDefinition = {
  key: string;
  label: string;
  description?: string | null;
  type: SystemSettingFieldType;
  value?: string | number | boolean | null;
  options?: SystemSettingOption[];
  revision: number;
  requiresRestart?: boolean;
  secretConfigured?: boolean;
};

export type SystemSettingsGroup = {
  key: string;
  label: string;
  description?: string | null;
  settings: SystemSettingDefinition[];
};

export type SystemSettingsResponse = {
  groups: SystemSettingsGroup[];
};

type DraftValue = string | number | boolean;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || data.message || "Request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function initialDrafts(groups: SystemSettingsGroup[]) {
  return Object.fromEntries(
    groups.flatMap((group) =>
      group.settings.map((setting) => [
        setting.key,
        setting.type === "password" ? "" : (setting.value ?? ""),
      ]),
    ),
  ) as Record<string, DraftValue>;
}

export function SystemSettingsPage() {
  const [groups, setGroups] = useState<SystemSettingsGroup[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState<"save" | "clear" | null>(
    null,
  );
  const [settingErrors, setSettingErrors] = useState<Record<string, string>>(
    {},
  );

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await request<SystemSettingsResponse>(
        "/api/admin/system-settings",
      );
      setGroups(response.groups);
      setDrafts(initialDrafts(response.groups));
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Failed to load system settings",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const updateSetting = async (
    setting: SystemSettingDefinition,
    value: DraftValue | null,
    action: "save" | "clear" = "save",
  ) => {
    setSavingKey(setting.key);
    setSavingAction(action);
    setSettingErrors((errors) => {
      const next = { ...errors };
      delete next[setting.key];
      return next;
    });
    try {
      await request(
        `/api/admin/system-settings/${encodeURIComponent(setting.key)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ value, revision: setting.revision }),
        },
      );
      toast.success(`${setting.label} updated.`);
      await load();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not update setting";
      setSettingErrors((errors) => ({ ...errors, [setting.key]: message }));
      toast.error(message);
    } finally {
      setSavingKey(null);
      setSavingAction(null);
    }
  };

  if (loading && groups.length === 0) {
    return (
      <div className="grid h-full min-h-64 place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading system settings</span>
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 p-4 md:p-8">
      <header className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Administration
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            System Settings
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Configure global application behavior. Changes apply to every user.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={loading || savingKey !== null}
          onClick={() => void load()}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </header>

      {loadError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load settings</AlertTitle>
          <AlertDescription>
            <p>{loadError}</p>
            <Button type="button" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loadError && groups.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No system settings are available.
        </div>
      )}

      <StorageProfilesSection />

      {groups.map((group) => (
        <section key={group.key} className="space-y-3">
          <div>
            <h2 className="text-lg font-medium">{group.label}</h2>
            {group.description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {group.description}
              </p>
            )}
          </div>
          <div className="divide-y rounded-lg border">
            {group.settings.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                value={drafts[setting.key] ?? ""}
                saving={savingKey === setting.key}
                savingAction={savingAction}
                disabled={savingKey !== null || loadError !== null}
                error={settingErrors[setting.key]}
                onChange={(value) =>
                  setDrafts((current) => ({
                    ...current,
                    [setting.key]: value,
                  }))
                }
                onSave={(value) => void updateSetting(setting, value)}
                onClear={() => void updateSetting(setting, null, "clear")}
              />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

type StorageProfile = {
  id: string;
  name: string;
  driver: "vercel-blob" | "s3" | "minio";
  hasCredentials: boolean;
  active: boolean;
  s3?: {
    endpoint?: string;
    region: string;
    bucket: string;
    publicBaseUrl?: string;
  };
};

function StorageProfilesSection() {
  const [profiles, setProfiles] = useState<StorageProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [adoptLegacyObjects, setAdoptLegacyObjects] = useState(false);
  const [form, setForm] = useState({
    name: "MinIO",
    driver: "minio" as "s3" | "minio",
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "iris",
    accessKeyId: "",
    secretAccessKey: "",
    publicBaseUrl: "",
  });
  const loadProfiles = async () => {
    const data = await request<{ profiles: StorageProfile[] }>(
      "/api/admin/system-settings/storage-profiles",
    );
    setProfiles(data.profiles);
  };
  useEffect(() => {
    void loadProfiles().catch(() => undefined);
  }, []);
  const create = async () => {
    setBusy(true);
    try {
      await request("/api/admin/system-settings/storage-profiles", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          forcePathStyle: form.driver === "minio",
          publicBaseUrl: form.publicBaseUrl || undefined,
          prefix: "uploads",
        }),
      });
      setForm((value) => ({
        ...value,
        accessKeyId: "",
        secretAccessKey: "",
      }));
      await loadProfiles();
      toast.success("MinIO profile created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to create profile",
      );
    } finally {
      setBusy(false);
    }
  };
  const action = async (id: string, type: "test" | "activate") => {
    setBusy(true);
    try {
      await request(
        `/api/admin/system-settings/storage-profiles/${id}/${type}`,
        {
          method: "POST",
          body: JSON.stringify({ adoptLegacyObjects }),
        },
      );
      await loadProfiles();
      toast.success(
        type === "test"
          ? "Storage connection verified"
          : "Storage profile activated",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Storage action failed",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-medium">Object Storage Profiles</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Create immutable S3-compatible profiles. MinIO credentials are
          encrypted and never returned.
        </p>
      </div>
      <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
        <label className="md:col-span-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={adoptLegacyObjects}
            onChange={(event) => setAdoptLegacyObjects(event.target.checked)}
          />
          Adopt existing untracked objects when activating the first profile
        </label>
        <div className="space-y-2">
          <Label htmlFor="storage-driver">Driver</Label>
          <select
            id="storage-driver"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={form.driver}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                driver: event.target.value as "s3" | "minio",
              }))
            }
          >
            <option value="minio">MinIO</option>
            <option value="s3">S3</option>
          </select>
        </div>
        {Object.entries(form).map(([key, value]) =>
          key === "driver" ? null : (
            <div key={key} className="space-y-2">
              <Label htmlFor={`storage-${key}`}>
                {key.replace(/([A-Z])/g, " $1")}
              </Label>
              <Input
                id={`storage-${key}`}
                type={key === "secretAccessKey" ? "password" : "text"}
                value={value}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
              />
            </div>
          ),
        )}
        <div className="md:col-span-2">
          <Button disabled={busy} onClick={() => void create()}>
            Create MinIO Profile
          </Button>
        </div>
      </div>
      <div className="divide-y rounded-lg border">
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{profile.name}</span>
                <Badge variant={profile.active ? "default" : "outline"}>
                  {profile.active ? "Active" : profile.driver}
                </Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {profile.s3?.endpoint ?? profile.driver}{" "}
                {profile.s3?.bucket ?? ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void action(profile.id, "test")}
              >
                Test
              </Button>
              <Button
                disabled={busy || profile.active}
                onClick={() => void action(profile.id, "activate")}
              >
                Activate
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SettingRow({
  setting,
  value,
  saving,
  savingAction,
  disabled,
  error,
  onChange,
  onSave,
  onClear,
}: {
  setting: SystemSettingDefinition;
  value: DraftValue;
  saving: boolean;
  savingAction: "save" | "clear" | null;
  disabled: boolean;
  error?: string;
  onChange: (value: DraftValue) => void;
  onSave: (value: DraftValue) => void;
  onClear: () => void;
}) {
  const inputId = `system-setting-${setting.key}`;
  const isSecret = setting.type === "password";
  const isUnchanged = !isSecret && value === (setting.value ?? "");
  const secretIsEmpty = isSecret && value === "";

  return (
    <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)] md:p-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={inputId} className="font-medium">
            {setting.label}
          </Label>
          {setting.requiresRestart && (
            <Badge
              variant="outline"
              className="border-amber-500/40 text-amber-700 dark:text-amber-400"
            >
              <RotateCcw />
              Restart required
            </Badge>
          )}
          <Badge variant="secondary">Revision {setting.revision}</Badge>
        </div>
        {setting.description && (
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {setting.description}
          </p>
        )}
        {isSecret && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" />
            {setting.secretConfigured
              ? "A secret is configured. Its value is never displayed."
              : "No secret is configured."}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <SettingControl
          id={inputId}
          setting={setting}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
        <div className="flex flex-wrap justify-end gap-2">
          {isSecret && setting.secretConfigured && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onClear}
            >
              {saving && savingAction === "clear" && (
                <Loader2 className="animate-spin" />
              )}
              Clear secret
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={disabled || isUnchanged || secretIsEmpty}
            onClick={() => onSave(value)}
          >
            {saving && savingAction === "save" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Save />
            )}
            {isSecret ? "Replace secret" : "Save"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-right text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function SettingControl({
  id,
  setting,
  value,
  disabled,
  onChange,
}: {
  id: string;
  setting: SystemSettingDefinition;
  value: DraftValue;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  if (setting.type === "boolean") {
    return (
      <div className="flex h-9 items-center justify-between rounded-md border px-3">
        <span className="text-sm">{value ? "Enabled" : "Disabled"}</span>
        <Switch
          id={id}
          checked={Boolean(value)}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </div>
    );
  }

  if (setting.type === "select") {
    return (
      <Select
        value={String(value)}
        disabled={disabled}
        onValueChange={onChange}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Select a value" />
        </SelectTrigger>
        <SelectContent>
          {(setting.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      id={id}
      type={setting.type === "password" ? "password" : setting.type}
      value={value as string | number}
      disabled={disabled}
      autoComplete={setting.type === "password" ? "new-password" : undefined}
      placeholder={
        setting.type === "password" ? "Enter a new secret" : undefined
      }
      onChange={(event) =>
        onChange(
          setting.type === "number"
            ? event.target.value === ""
              ? ""
              : event.target.valueAsNumber
            : event.target.value,
        )
      }
    />
  );
}
