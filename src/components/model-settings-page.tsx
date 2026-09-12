"use client";

import { notify } from "lib/notify";
import { cn } from "lib/utils";
import {
  ChevronLeft,
  Cpu,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { Switch } from "ui/switch";

type Provider = {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  enabled: boolean;
  apiKey: string | null;
  modelCount: number;
  lastConnectionStatus: string | null;
  lastConnectionError: string | null;
};
type Model = {
  id: string;
  providerId: string;
  provider: string;
  name: string;
  apiModelId: string;
  apiVersion: string | null;
  contextWindow: number;
  enabled: boolean;
  isDefault: boolean;
  modelKind: "chat" | "embedding";
  capabilities: {
    toolCalls: boolean;
    vision: boolean;
    structuredOutput: boolean;
  };
};
type EngineModel = {
  id: string;
  provider: string;
  name: string;
  modelKind: "chat" | "embedding";
  capabilities: Model["capabilities"];
  contextWindow: number;
};
type SystemEngine = {
  key: string;
  label: string;
  description: string;
  category: "background" | "auxiliary" | "vector";
  modelKind: "chat" | "embedding";
  requiredCapabilities: Partial<Model["capabilities"]>;
  assignedModelId: string | null;
  effectiveModel: EngineModel | null;
  candidates: EngineModel[];
  isFallback: boolean;
  warning: string | null;
};
const providerTypes = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "groq",
  "openrouter",
  "ollama",
  "azure-openai",
  "openai-compatible",
];
const providerAccents: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d97757",
  google: "#4285f4",
  xai: "#8f8f8f",
  groq: "#f55036",
  openrouter: "#8b8cf6",
  ollama: "#a78bfa",
  "azure-openai": "#0078d4",
  "openai-compatible": "#8f8f8f",
};

const emptyProviderForm = {
  name: "",
  type: "openai-compatible",
  baseUrl: "",
  apiKey: "",
  enabled: true,
};
const emptyModelForm = {
  name: "",
  apiModelId: "",
  apiVersion: "",
  contextWindow: 128000,
  toolCalls: true,
  vision: false,
  structuredOutput: true,
  enabled: true,
  isDefault: false,
};

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

function formatContextWindow(tokens: number) {
  return tokens % 1000 === 0
    ? `${Math.round(tokens / 1000)}k tokens`
    : `${tokens.toLocaleString()} tokens`;
}

export function ModelSettingsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [engines, setEngines] = useState<SystemEngine[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(
    null,
  );
  const [savingEngineKey, setSavingEngineKey] = useState<string | null>(null);

  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [providerForm, setProviderForm] = useState(emptyProviderForm);

  const [modelsProviderId, setModelsProviderId] = useState<string | null>(null);
  const [modelView, setModelView] = useState<"list" | "form">("list");
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [modelForm, setModelForm] = useState(emptyModelForm);

  const modelsProvider =
    providers.find((provider) => provider.id === modelsProviderId) || null;
  const providerModels = models.filter(
    (model) => model.providerId === modelsProviderId,
  );

  const load = async () => {
    setLoading(true);
    try {
      const [nextProviders, nextModels, nextEngines] = await Promise.all([
        request<Provider[]>("/api/admin/model-settings/providers"),
        request<Model[]>("/api/admin/model-settings/models"),
        request<SystemEngine[]>("/api/admin/model-settings/engines"),
      ]);
      setProviders(nextProviders);
      setModels(nextModels);
      setEngines(nextEngines);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load model settings",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const openAddProvider = () => {
    setEditingProvider(null);
    setProviderForm(emptyProviderForm);
    setProviderDialogOpen(true);
  };
  const openEditProvider = (provider: Provider) => {
    setEditingProvider(provider);
    setProviderForm({
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl || "",
      apiKey: "",
      enabled: provider.enabled,
    });
    setProviderDialogOpen(true);
  };
  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await request(
        editingProvider
          ? `/api/admin/model-settings/providers/${editingProvider.id}`
          : "/api/admin/model-settings/providers",
        {
          method: editingProvider ? "PATCH" : "POST",
          body: JSON.stringify(providerForm),
        },
      );
      toast.success(
        editingProvider
          ? "Provider updated."
          : "Provider saved. Add a model to make it available.",
      );
      setProviderDialogOpen(false);
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save provider",
      );
    } finally {
      setSaving(false);
    }
  };
  const deleteProvider = async (provider: Provider) => {
    const ok = await notify.confirm({
      title: `Delete ${provider.name}?`,
      description: `All ${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"} registered under this provider will be removed. This cannot be undone.`,
      okText: "Delete",
    });
    if (!ok) return;
    try {
      await request(`/api/admin/model-settings/providers/${provider.id}`, {
        method: "DELETE",
      });
      toast.success("Provider deleted.");
      if (modelsProviderId === provider.id) setModelsProviderId(null);
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not delete provider",
      );
    }
  };
  const testProvider = async (id: string) => {
    setTestingProviderId(id);
    try {
      const result = await request<{ message: string }>(
        `/api/admin/model-settings/providers/${id}/test`,
        { method: "POST" },
      );
      toast.success(result.message);
      setProviders((items) =>
        items.map((provider) =>
          provider.id === id
            ? {
                ...provider,
                lastConnectionStatus: "connected",
                lastConnectionError: null,
              }
            : provider,
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connection failed";
      toast.error(message);
      setProviders((items) =>
        items.map((provider) =>
          provider.id === id
            ? {
                ...provider,
                lastConnectionStatus: "error",
                lastConnectionError: message,
              }
            : provider,
        ),
      );
    } finally {
      setTestingProviderId(null);
    }
  };

  const openModels = (provider: Provider) => {
    setModelsProviderId(provider.id);
    setModelView("list");
    setEditingModel(null);
  };
  const openAddModel = () => {
    setEditingModel(null);
    setModelForm(emptyModelForm);
    setModelView("form");
  };
  const openEditModel = (model: Model) => {
    setEditingModel(model);
    setModelForm({
      name: model.name,
      apiModelId: model.apiModelId,
      apiVersion: model.apiVersion || "",
      contextWindow: model.contextWindow,
      toolCalls: model.capabilities.toolCalls,
      vision: model.capabilities.vision,
      structuredOutput: model.capabilities.structuredOutput,
      enabled: model.enabled,
      isDefault: model.isDefault,
    });
    setModelView("form");
  };
  const saveModel = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await request(
        editingModel
          ? `/api/admin/model-settings/models/${editingModel.id}`
          : "/api/admin/model-settings/models",
        {
          method: editingModel ? "PATCH" : "POST",
          body: JSON.stringify({
            ...modelForm,
            providerId: modelsProviderId,
            modelKind: "chat",
            capabilities: {
              toolCalls: modelForm.toolCalls,
              vision: modelForm.vision,
              structuredOutput: modelForm.structuredOutput,
            },
          }),
        },
      );
      toast.success(
        editingModel
          ? "Model updated."
          : "Model saved and available immediately.",
      );
      setModelView("list");
      setEditingModel(null);
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save model",
      );
    } finally {
      setSaving(false);
    }
  };
  const deleteModel = async (model: Model) => {
    const ok = await notify.confirm({
      title: `Delete ${model.name}?`,
      description:
        "Agents using this model will fall back to the default. This cannot be undone.",
      okText: "Delete",
    });
    if (!ok) return;
    try {
      await request(`/api/admin/model-settings/models/${model.id}`, {
        method: "DELETE",
      });
      toast.success("Model deleted.");
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not delete model",
      );
    }
  };

  const saveEngine = async (engineKey: string, modelId: string | null) => {
    setSavingEngineKey(engineKey);
    try {
      const updated = await request<SystemEngine>(
        "/api/admin/model-settings/engines",
        {
          method: "PATCH",
          body: JSON.stringify({ engineKey, modelId }),
        },
      );
      setEngines((items) =>
        items.map((engine) => (engine.key === updated.key ? updated : engine)),
      );
      toast.success(`${updated.label} model updated.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update engine",
      );
    } finally {
      setSavingEngineKey(null);
    }
  };

  if (loading)
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="animate-spin text-muted-foreground" />
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Model Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure global AI providers and the models available to everyone.
          </p>
        </div>
        <Button onClick={openAddProvider}>
          <Plus />
          Add provider
        </Button>
      </div>

      <section className="mt-8">
        <SectionHeading title="Providers" />
        {providers.length === 0 ? (
          <EmptyState
            text="No providers yet. Add a provider to begin configuring models."
            action={
              <Button variant="outline" onClick={openAddProvider}>
                <Plus />
                Add provider
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {providers.map((provider) => {
              const accent = providerAccents[provider.type] || "#8f8f8f";
              return (
                <Card
                  key={provider.id}
                  className="group min-h-[176px] gap-3 py-5 transition-colors hover:bg-input"
                >
                  <CardHeader className="shrink gap-y-0">
                    <CardTitle className="flex items-start gap-3">
                      <span
                        style={{
                          backgroundColor: `${accent}1f`,
                          color: accent,
                        }}
                        className="flex shrink-0 items-center justify-center rounded-lg border p-2 ring-1 ring-background"
                      >
                        <ModelProviderIcon
                          provider={provider.type}
                          className="size-5"
                        />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col justify-around gap-1 overflow-hidden">
                        <span
                          className="truncate font-medium"
                          title={provider.name}
                        >
                          {provider.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {provider.type} · {provider.modelCount} model
                          {provider.modelCount === 1 ? "" : "s"}
                        </span>
                      </span>
                      <Badge
                        variant={provider.enabled ? "secondary" : "outline"}
                        className={cn(
                          !provider.enabled && "text-muted-foreground",
                        )}
                      >
                        {provider.enabled ? "Active" : "Disabled"}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="min-h-0 grow">
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          provider.lastConnectionStatus === "connected"
                            ? "bg-emerald-500"
                            : provider.lastConnectionStatus === "error"
                              ? "bg-destructive"
                              : "bg-muted-foreground/40",
                        )}
                      />
                      <span
                        className="truncate"
                        title={provider.baseUrl || undefined}
                      >
                        {provider.baseUrl || "Provider default endpoint"}
                      </span>
                    </p>
                    {provider.lastConnectionStatus === "error" && (
                      <p className="mt-1.5 line-clamp-2 text-xs text-destructive">
                        {provider.lastConnectionError}
                      </p>
                    )}
                  </CardContent>
                  <CardFooter className="shrink">
                    <div className="flex w-full items-center gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openModels(provider)}
                      >
                        <Server />
                        Models
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={testingProviderId === provider.id}
                        onClick={() => void testProvider(provider.id)}
                      >
                        <RefreshCw
                          className={cn(
                            testingProviderId === provider.id && "animate-spin",
                          )}
                        />
                        {testingProviderId === provider.id
                          ? "Testing…"
                          : "Test"}
                      </Button>
                      <div className="ml-auto">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              aria-label={`Actions for ${provider.name}`}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => openEditProvider(provider)}
                            >
                              <Pencil />
                              Edit provider
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => void deleteProvider(provider)}
                            >
                              <Trash2 />
                              Delete provider
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-10">
        <SectionHeading title="System Engines" />
        <p className="mb-4 text-sm text-muted-foreground">
          Assign an enabled model to each internal IRIS engine. Thread titles
          and context summaries are not listed here — they inherit the
          conversation or default model automatically.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {engines.map((engine) => (
            <Card key={engine.key} className="gap-4 py-5">
              <CardHeader className="shrink gap-y-1">
                <CardTitle className="flex items-start justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Cpu className="size-4 text-muted-foreground" />
                    {engine.label}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(
                      engine.isFallback
                        ? "border-amber-500/30 text-amber-600"
                        : "border-emerald-500/30 text-emerald-600",
                    )}
                  >
                    {engine.isFallback ? "Fallback" : "Assigned"}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  {engine.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor={`engine-${engine.key}`}>Model</Label>
                <select
                  id={`engine-${engine.key}`}
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  value={engine.assignedModelId ?? ""}
                  disabled={savingEngineKey === engine.key}
                  onChange={(event) =>
                    void saveEngine(engine.key, event.target.value || null)
                  }
                >
                  <option value="">Use compatible default</option>
                  {engine.candidates.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.provider} / {model.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Requires {engine.modelKind}
                  {engine.requiredCapabilities.toolCalls
                    ? ", tool calling"
                    : ""}
                  {engine.requiredCapabilities.structuredOutput
                    ? ", structured output"
                    : ""}
                  . Effective:{" "}
                  {engine.effectiveModel
                    ? `${engine.effectiveModel.provider} / ${engine.effectiveModel.name}`
                    : "none"}
                </p>
                {engine.warning && (
                  <p className="flex gap-2 text-xs text-amber-600">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                    {engine.warning}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Provider add / edit dialog */}
      <Dialog
        open={providerDialogOpen}
        onOpenChange={(open) => {
          if (!open) setProviderDialogOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingProvider ? "Edit provider" : "Add provider"}
            </DialogTitle>
            <DialogDescription>
              {editingProvider
                ? "Update the connection details for this provider."
                : "Register an AI provider, then add its models."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveProvider} className="grid gap-4">
            <Field label="Provider name">
              <Input
                value={providerForm.name}
                onChange={(e) =>
                  setProviderForm({ ...providerForm, name: e.target.value })
                }
                placeholder="My OpenAI-compatible API"
                required
              />
            </Field>
            <Field label="Provider type">
              <select
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                value={providerForm.type}
                onChange={(e) =>
                  setProviderForm({ ...providerForm, type: e.target.value })
                }
              >
                {providerTypes.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </Field>
            <Field label="Endpoint (required for compatible, Azure, Ollama)">
              <Input
                value={providerForm.baseUrl}
                onChange={(e) =>
                  setProviderForm({ ...providerForm, baseUrl: e.target.value })
                }
                placeholder="https://api.example.com/v1"
              />
            </Field>
            <Field label="API key">
              <Input
                type="password"
                value={providerForm.apiKey}
                onChange={(e) =>
                  setProviderForm({ ...providerForm, apiKey: e.target.value })
                }
                placeholder={
                  editingProvider
                    ? "Leave blank to keep the existing key"
                    : "Stored encrypted"
                }
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={providerForm.enabled}
                onCheckedChange={(enabled) =>
                  setProviderForm({ ...providerForm, enabled })
                }
              />
              Enable provider
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setProviderDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {editingProvider ? "Save changes" : "Add provider"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Provider models dialog */}
      <Dialog
        open={modelsProviderId !== null}
        onOpenChange={(open) => {
          if (!open) setModelsProviderId(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          {modelsProvider &&
            (modelView === "form" ? (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="-ml-2 size-8"
                      aria-label="Back to models"
                      onClick={() => {
                        setModelView("list");
                        setEditingModel(null);
                      }}
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    {editingModel ? `Edit ${editingModel.name}` : "Add model"}
                  </DialogTitle>
                  <DialogDescription>{modelsProvider.name}</DialogDescription>
                </DialogHeader>
                <form onSubmit={saveModel} className="grid gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Display name">
                      <Input
                        value={modelForm.name}
                        onChange={(e) =>
                          setModelForm({ ...modelForm, name: e.target.value })
                        }
                        placeholder="GPT-4.1"
                        required
                      />
                    </Field>
                    <Field label="API model ID / deployment">
                      <Input
                        value={modelForm.apiModelId}
                        onChange={(e) =>
                          setModelForm({
                            ...modelForm,
                            apiModelId: e.target.value,
                          })
                        }
                        placeholder="gpt-4.1"
                        required
                      />
                    </Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {modelsProvider.type === "azure-openai" && (
                      <Field label="Azure API version">
                        <Input
                          value={modelForm.apiVersion}
                          onChange={(e) =>
                            setModelForm({
                              ...modelForm,
                              apiVersion: e.target.value,
                            })
                          }
                          placeholder="2025-01-01-preview"
                          required
                        />
                      </Field>
                    )}
                    <Field label="Context window (tokens)">
                      <Input
                        type="number"
                        min={1024}
                        value={modelForm.contextWindow}
                        onChange={(e) =>
                          setModelForm({
                            ...modelForm,
                            contextWindow: Number(e.target.value),
                          })
                        }
                        required
                      />
                    </Field>
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-3">
                    <Toggle
                      label="Enabled"
                      checked={modelForm.enabled}
                      onChange={(enabled) =>
                        setModelForm({ ...modelForm, enabled })
                      }
                    />
                    <Toggle
                      label="Tools"
                      checked={modelForm.toolCalls}
                      onChange={(toolCalls) =>
                        setModelForm({ ...modelForm, toolCalls })
                      }
                    />
                    <Toggle
                      label="Vision"
                      checked={modelForm.vision}
                      onChange={(vision) =>
                        setModelForm({ ...modelForm, vision })
                      }
                    />
                    <Toggle
                      label="Structured output"
                      checked={modelForm.structuredOutput}
                      onChange={(structuredOutput) =>
                        setModelForm({ ...modelForm, structuredOutput })
                      }
                    />
                    <Toggle
                      label="Default"
                      checked={modelForm.isDefault}
                      onChange={(isDefault) =>
                        setModelForm({ ...modelForm, isDefault })
                      }
                    />
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setModelView("list");
                        setEditingModel(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={saving}>
                      {editingModel ? "Save changes" : "Add model"}
                    </Button>
                  </DialogFooter>
                </form>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2.5">
                    <ProviderGlyph
                      type={modelsProvider.type}
                      className="size-7"
                      iconClassName="size-4"
                    />
                    <span className="truncate">{modelsProvider.name}</span>
                  </DialogTitle>
                  <DialogDescription>
                    {providerModels.length} model
                    {providerModels.length === 1 ? "" : "s"} available from this
                    provider.
                  </DialogDescription>
                </DialogHeader>
                <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                  {providerModels.length === 0 ? (
                    <EmptyState text="No models registered for this provider yet." />
                  ) : (
                    providerModels.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center gap-3 rounded-lg border p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className="truncate text-sm font-medium"
                              title={model.name}
                            >
                              {model.name}
                            </span>
                            {model.isDefault && (
                              <Badge variant="secondary">Default</Badge>
                            )}
                            {!model.enabled && (
                              <Badge
                                variant="outline"
                                className="text-muted-foreground"
                              >
                                Disabled
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {model.apiModelId} ·{" "}
                            {formatContextWindow(model.contextWindow)}
                          </p>
                        </div>
                        <div className="hidden shrink-0 gap-1.5 sm:flex">
                          {model.capabilities.toolCalls && (
                            <CapChip>Tools</CapChip>
                          )}
                          {model.capabilities.vision && (
                            <CapChip>Vision</CapChip>
                          )}
                          {model.capabilities.structuredOutput && (
                            <CapChip>JSON</CapChip>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            aria-label={`Edit ${model.name}`}
                            onClick={() => openEditModel(model)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 text-destructive"
                            aria-label={`Delete ${model.name}`}
                            onClick={() => void deleteModel(model)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <DialogFooter className="sm:justify-between">
                  <Button variant="outline" onClick={openAddModel}>
                    <Plus />
                    Add model
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setModelsProviderId(null)}
                  >
                    Done
                  </Button>
                </DialogFooter>
              </>
            ))}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderGlyph({
  type,
  className,
  iconClassName,
}: {
  type: string;
  className?: string;
  iconClassName?: string;
}) {
  const accent = providerAccents[type] || "#8f8f8f";
  return (
    <span
      style={{ backgroundColor: `${accent}1f`, color: accent }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border ring-1 ring-background",
        className,
      )}
    >
      <ModelProviderIcon provider={type} className={iconClassName} />
    </span>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function CapChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">
      {children}
    </span>
  );
}

function Field({
  label,
  children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

function EmptyState({
  text,
  action,
}: { text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-10 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}
