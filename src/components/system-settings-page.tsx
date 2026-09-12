"use client";

import { AlertCircle, Loader2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { Checkbox } from "ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "ui/dialog";
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
  ) => {
    setSavingKey(setting.key);
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

  const disabled = savingKey !== null || loadError !== null;

  return (
    <main className="w-full space-y-6 p-4 md:p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            System Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure global application behavior. Changes apply to every user.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
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

      <StorageProfilesSection />

      {groups.map((group) => (
        <Card key={group.key}>
          <CardHeader>
            <CardTitle className="text-base">{group.label}</CardTitle>
            {group.description && (
              <CardDescription>{group.description}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="divide-y">
            {group.settings.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                value={drafts[setting.key] ?? ""}
                saving={savingKey === setting.key}
                disabled={disabled}
                error={settingErrors[setting.key]}
                onChange={(value) =>
                  setDrafts((current) => ({
                    ...current,
                    [setting.key]: value,
                  }))
                }
                onSave={(value) => void updateSetting(setting, value)}
                onClear={() => void updateSetting(setting, null)}
              />
            ))}
          </CardContent>
        </Card>
      ))}

      {!loadError && groups.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No system settings are available.
        </div>
      )}
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

const STORAGE_FIELDS = [
  { key: "name", label: "Profile name", placeholder: "Defaults to driver" },
  { key: "region", label: "Region", placeholder: "us-east-1" },
  { key: "endpoint", label: "Endpoint", placeholder: "http://localhost:9000" },
  {
    key: "publicBaseUrl",
    label: "Public base URL",
    placeholder: "Optional",
  },
  { key: "bucket", label: "Bucket", placeholder: "iris" },
  { key: "accessKeyId", label: "Access key ID", placeholder: "" },
] as const;

function StorageProfilesSection() {
  const [profiles, setProfiles] = useState<StorageProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [adoptLegacyObjects, setAdoptLegacyObjects] = useState(false);
  const [form, setForm] = useState({
    name: "",
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
          name: form.name || form.driver,
          forcePathStyle: form.driver === "minio",
          publicBaseUrl: form.publicBaseUrl || undefined,
          prefix: "uploads",
        }),
      });
      setForm((value) => ({ ...value, accessKeyId: "", secretAccessKey: "" }));
      setDialogOpen(false);
      await loadProfiles();
      toast.success("Storage profile created");
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

  const canCreate = form.accessKeyId !== "" && form.secretAccessKey !== "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Object Storage</CardTitle>
        <CardDescription>
          S3-compatible storage for uploads and artifacts. Credentials are
          encrypted and never returned after saving.
        </CardDescription>
        <CardAction>
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1">
                <Plus />
                New profile
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>New storage profile</DialogTitle>
                <DialogDescription>
                  Profiles are immutable. Create a new one to change
                  credentials.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="storage-driver">Driver</Label>
                  <Select
                    value={form.driver}
                    onValueChange={(value) =>
                      setForm((current) => ({
                        ...current,
                        driver: value as "s3" | "minio",
                      }))
                    }
                  >
                    <SelectTrigger id="storage-driver" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minio">MinIO</SelectItem>
                      <SelectItem value="s3">S3</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {STORAGE_FIELDS.map((field) => (
                  <div
                    key={field.key}
                    className={`space-y-2${
                      field.key === "accessKeyId" || field.key === "name"
                        ? " sm:col-span-2"
                        : ""
                    }`}
                  >
                    <Label htmlFor={`storage-${field.key}`}>
                      {field.label}
                    </Label>
                    <Input
                      id={`storage-${field.key}`}
                      type="text"
                      value={form[field.key]}
                      placeholder={field.placeholder || undefined}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="storage-secretAccessKey">
                    Secret access key
                  </Label>
                  <Input
                    id="storage-secretAccessKey"
                    type="password"
                    value={form.secretAccessKey}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        secretAccessKey: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  disabled={busy || !canCreate}
                  onClick={() => void create()}
                >
                  {busy && <Loader2 className="animate-spin" />}
                  Create profile
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {profiles.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No storage profile yet. Create one to enable uploads.
          </p>
        ) : (
          <div className="divide-y rounded-lg border">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex flex-col gap-3 px-4 py-3 first:rounded-t-lg last:rounded-b-lg sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{profile.name}</span>
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
                    size="sm"
                    disabled={busy}
                    onClick={() => void action(profile.id, "test")}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || profile.active}
                    onClick={() => void action(profile.id, "activate")}
                  >
                    Activate
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {!profilesWithActive(profiles) && profiles.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={adoptLegacyObjects}
              onCheckedChange={(checked) =>
                setAdoptLegacyObjects(checked === true)
              }
            />
            Adopt existing untracked objects when activating the first profile
          </label>
        )}
      </CardContent>
    </Card>
  );
}

function profilesWithActive(profiles: StorageProfile[]) {
  return profiles.some((profile) => profile.active);
}

function SettingRow({
  setting,
  value,
  saving,
  disabled,
  error,
  onChange,
  onSave,
  onClear,
}: {
  setting: SystemSettingDefinition;
  value: DraftValue;
  saving: boolean;
  disabled: boolean;
  error?: string;
  onChange: (value: DraftValue) => void;
  onSave: (value: DraftValue) => void;
  onClear: () => void;
}) {
  const inputId = `system-setting-${setting.key}`;
  const isSecret = setting.type === "password";
  const isDirty = !isSecret && value !== (setting.value ?? "");
  const showSave = setting.type !== "boolean" && (isSecret || isDirty);
  const showClear = isSecret && setting.secretConfigured === true;

  return (
    <div className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0 md:flex-row md:items-center md:gap-6">
      <div className="min-w-0 md:w-1/3 md:shrink-0">
        <Label htmlFor={inputId} className="font-medium">
          {setting.label}
        </Label>
        {isSecret && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {setting.secretConfigured
              ? "Configured — value is never displayed."
              : "Not configured."}
          </p>
        )}
      </div>

      <div className="w-full min-w-0">
        <div className="flex items-center gap-2">
          {setting.type === "boolean" ? (
            <div className="flex flex-1 justify-end">
              <Switch
                id={inputId}
                checked={Boolean(value)}
                disabled={disabled || saving}
                onCheckedChange={(checked) => {
                  onChange(checked);
                  onSave(checked);
                }}
              />
            </div>
          ) : setting.type === "select" ? (
            <Select
              value={String(value)}
              disabled={disabled}
              onValueChange={onChange}
            >
              <SelectTrigger id={inputId} className="flex-1">
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
          ) : (
            <Input
              id={inputId}
              type={isSecret ? "password" : setting.type}
              value={value as string | number}
              disabled={disabled}
              autoComplete={isSecret ? "new-password" : undefined}
              placeholder={isSecret ? "Enter a new secret" : undefined}
              onChange={(event) =>
                onChange(
                  setting.type === "number"
                    ? event.target.value === ""
                      ? ""
                      : event.target.valueAsNumber
                    : event.target.value,
                )
              }
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !disabled &&
                  (isSecret ? value !== "" : isDirty)
                ) {
                  onSave(value);
                }
              }}
            />
          )}

          {showSave && (
            <Button
              type="button"
              size="sm"
              variant={isSecret ? "default" : "outline"}
              disabled={disabled || (isSecret && value === "")}
              onClick={() => onSave(value)}
            >
              {saving && <Loader2 className="animate-spin" />}
              {isSecret ? "Replace" : "Save"}
            </Button>
          )}
          {isSecret && showClear && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={onClear}
            >
              Clear
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
