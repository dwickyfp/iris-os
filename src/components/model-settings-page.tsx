"use client";

import {
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Switch } from "ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "ui/tabs";

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
  isCurator: boolean;
  isEmbeddingDefault: boolean;
  embeddingDimensions: number | null;
  capabilities: {
    toolCalls: boolean;
    vision: boolean;
    structuredOutput: boolean;
  };
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

export function ModelSettingsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(
    null,
  );
  const [editingProviderId, setEditingProviderId] = useState<string | null>(
    null,
  );
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState({
    name: "",
    type: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    enabled: true,
  });
  const [modelForm, setModelForm] = useState({
    providerId: "",
    name: "",
    apiModelId: "",
    apiVersion: "",
    contextWindow: 128000,
    toolCalls: true,
    vision: false,
    structuredOutput: true,
    enabled: true,
    isDefault: false,
    modelKind: "chat" as "chat" | "embedding",
    isCurator: false,
    isEmbeddingDefault: false,
    embeddingDimensions: 1536,
  });
  const load = async () => {
    setLoading(true);
    try {
      const [nextProviders, nextModels] = await Promise.all([
        request<Provider[]>("/api/admin/model-settings/providers"),
        request<Model[]>("/api/admin/model-settings/models"),
      ]);
      setProviders(nextProviders);
      setModels(nextModels);
      setModelForm((state) => ({
        ...state,
        providerId: state.providerId || nextProviders[0]?.id || "",
      }));
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
  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await request(
        editingProviderId
          ? `/api/admin/model-settings/providers/${editingProviderId}`
          : "/api/admin/model-settings/providers",
        {
          method: editingProviderId ? "PATCH" : "POST",
          body: JSON.stringify(providerForm),
        },
      );
      toast.success(
        editingProviderId
          ? "Provider updated."
          : "Provider saved. Add a model to make it available.",
      );
      setEditingProviderId(null);
      setProviderForm({
        name: "",
        type: "openai-compatible",
        baseUrl: "",
        apiKey: "",
        enabled: true,
      });
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save provider",
      );
    } finally {
      setSaving(false);
    }
  };
  const saveModel = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await request(
        editingModelId
          ? `/api/admin/model-settings/models/${editingModelId}`
          : "/api/admin/model-settings/models",
        {
          method: editingModelId ? "PATCH" : "POST",
          body: JSON.stringify({
            ...modelForm,
            capabilities: {
              toolCalls: modelForm.toolCalls,
              vision: modelForm.vision,
              structuredOutput: modelForm.structuredOutput,
            },
          }),
        },
      );
      toast.success(
        editingModelId
          ? "Model updated."
          : "Model saved and available immediately.",
      );
      setEditingModelId(null);
      setModelForm((state) => ({
        ...state,
        name: "",
        apiModelId: "",
        apiVersion: "",
      }));
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save model",
      );
    } finally {
      setSaving(false);
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
  const editProvider = (provider: Provider) => {
    setEditingProviderId(provider.id);
    setProviderForm({
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl || "",
      apiKey: "",
      enabled: provider.enabled,
    });
  };
  const editModel = (model: Model) => {
    setEditingModelId(model.id);
    setModelForm({
      providerId: model.providerId,
      name: model.name,
      apiModelId: model.apiModelId,
      apiVersion: model.apiVersion || "",
      contextWindow: model.contextWindow,
      toolCalls: model.capabilities.toolCalls,
      vision: model.capabilities.vision,
      structuredOutput: model.capabilities.structuredOutput,
      enabled: model.enabled,
      isDefault: model.isDefault,
      modelKind: model.modelKind,
      isCurator: model.isCurator,
      isEmbeddingDefault: model.isEmbeddingDefault,
      embeddingDimensions: model.embeddingDimensions || 1536,
    });
  };
  if (loading)
    return (
      <div className="h-full grid place-items-center">
        <Loader2 className="animate-spin text-muted-foreground" />
      </div>
    );
  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Model Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Configure global AI providers and the models available to everyone.
        </p>
      </div>
      <Tabs defaultValue="providers">
        <TabsList className="mb-6">
          <TabsTrigger value="providers">
            <Server className="mr-2 size-4" />
            Providers
          </TabsTrigger>
          <TabsTrigger value="models">
            <Sparkles className="mr-2 size-4" />
            Models
          </TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="space-y-6">
          <section className="rounded-lg border p-5">
            <h2 className="font-medium">
              {editingProviderId ? "Edit provider" : "Add provider"}
            </h2>
            <form
              onSubmit={saveProvider}
              className="mt-4 grid gap-4 md:grid-cols-2"
            >
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
                    setProviderForm({
                      ...providerForm,
                      baseUrl: e.target.value,
                    })
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
                    editingProviderId
                      ? "Leave blank to keep the existing key"
                      : "Stored encrypted"
                  }
                />
              </Field>
              <div className="flex items-center gap-3">
                <Switch
                  checked={providerForm.enabled}
                  onCheckedChange={(enabled) =>
                    setProviderForm({ ...providerForm, enabled })
                  }
                />
                <Label>Enable provider</Label>
              </div>
              <div className="flex justify-end gap-2">
                {editingProviderId && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditingProviderId(null);
                      setProviderForm({
                        name: "",
                        type: "openai-compatible",
                        baseUrl: "",
                        apiKey: "",
                        enabled: true,
                      });
                    }}
                  >
                    Cancel
                  </Button>
                )}
                <Button disabled={saving}>
                  <Plus className="mr-2 size-4" />
                  {editingProviderId ? "Save provider" : "Add provider"}
                </Button>
              </div>
            </form>
          </section>
          <section className="grid gap-3 md:grid-cols-2">
            {providers.length === 0 ? (
              <Empty text="No providers yet. Add a provider to begin configuring models." />
            ) : (
              providers.map((provider) => (
                <div key={provider.id} className="rounded-lg border p-4">
                  <div className="flex justify-between gap-3">
                    <div>
                      <h3 className="font-medium">{provider.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {provider.type} · {provider.modelCount} model
                        {provider.modelCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <span
                      className={
                        provider.enabled
                          ? "text-xs text-emerald-600"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {provider.enabled ? "Active" : "Disabled"}
                    </span>
                  </div>
                  <p className="mt-3 truncate text-xs text-muted-foreground">
                    {provider.baseUrl || "Provider default endpoint"}
                  </p>
                  <div className="mt-4 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={testingProviderId === provider.id}
                      onClick={() => void testProvider(provider.id)}
                    >
                      <RefreshCw
                        className={`mr-1 size-3 ${
                          testingProviderId === provider.id
                            ? "animate-spin"
                            : ""
                        }`}
                      />
                      {testingProviderId === provider.id
                        ? "Testing…"
                        : "Test connection"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => editProvider(provider)}
                    >
                      <Pencil className="size-4" />
                      <span className="sr-only">Edit {provider.name}</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto text-destructive"
                      onClick={async () => {
                        if (confirm(`Delete ${provider.name}?`)) {
                          try {
                            await request(
                              `/api/admin/model-settings/providers/${provider.id}`,
                              { method: "DELETE" },
                            );
                            await load();
                          } catch (error) {
                            toast.error(
                              error instanceof Error
                                ? error.message
                                : "Could not delete provider",
                            );
                          }
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  {provider.lastConnectionStatus === "error" && (
                    <p className="mt-2 text-xs text-destructive">
                      {provider.lastConnectionError}
                    </p>
                  )}
                </div>
              ))
            )}
          </section>
        </TabsContent>
        <TabsContent value="models" className="space-y-6">
          <section className="rounded-lg border p-5">
            <h2 className="font-medium">
              {editingModelId ? "Edit model" : "Add model"}
            </h2>
            {providers.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Add a provider first.
              </p>
            ) : (
              <form
                onSubmit={saveModel}
                className="mt-4 grid gap-4 md:grid-cols-2"
              >
                <Field label="Provider">
                  <select
                    className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={modelForm.providerId}
                    onChange={(e) =>
                      setModelForm({ ...modelForm, providerId: e.target.value })
                    }
                  >
                    {providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </Field>
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
                <Field label="Model role">
                  <select
                    className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={modelForm.modelKind}
                    onChange={(event) =>
                      setModelForm({
                        ...modelForm,
                        modelKind: event.target.value as "chat" | "embedding",
                      })
                    }
                  >
                    <option value="chat">Chat / Curator</option>
                    <option value="embedding">Memory embedding</option>
                  </select>
                </Field>
                <Field label="API model ID / deployment">
                  <Input
                    value={modelForm.apiModelId}
                    onChange={(e) =>
                      setModelForm({ ...modelForm, apiModelId: e.target.value })
                    }
                    placeholder="gpt-4.1"
                    required
                  />
                </Field>
                {providers.find(
                  (provider) => provider.id === modelForm.providerId,
                )?.type === "azure-openai" && (
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
                {modelForm.modelKind === "embedding" && (
                  <Field label="Embedding dimensions">
                    <Input
                      type="number"
                      min={1}
                      value={modelForm.embeddingDimensions}
                      onChange={(event) =>
                        setModelForm({
                          ...modelForm,
                          embeddingDimensions: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                )}
                <div className="flex flex-wrap gap-4">
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
                  {modelForm.modelKind === "chat" && (
                    <Toggle
                      label="Dedicated curator"
                      checked={modelForm.isCurator}
                      onChange={(isCurator) =>
                        setModelForm({ ...modelForm, isCurator })
                      }
                    />
                  )}
                  {modelForm.modelKind === "embedding" && (
                    <Toggle
                      label="Default embedding"
                      checked={modelForm.isEmbeddingDefault}
                      onChange={(isEmbeddingDefault) =>
                        setModelForm({ ...modelForm, isEmbeddingDefault })
                      }
                    />
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  {editingModelId && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setEditingModelId(null);
                        setModelForm((state) => ({
                          ...state,
                          name: "",
                          apiModelId: "",
                          apiVersion: "",
                        }));
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                  <Button disabled={saving}>
                    <Plus className="mr-2 size-4" />
                    {editingModelId ? "Save model" : "Add model"}
                  </Button>
                </div>
              </form>
            )}
          </section>
          <section className="space-y-3">
            {models.length === 0 ? (
              <Empty text="No models configured." />
            ) : (
              models.map((model) => (
                <div
                  key={model.id}
                  className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{model.name}</h3>
                      {model.isDefault && (
                        <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          Default
                        </span>
                      )}
                      {model.isCurator && (
                        <span className="rounded bg-violet-500/10 px-2 py-0.5 text-xs text-violet-500">
                          Curator
                        </span>
                      )}
                      {model.isEmbeddingDefault && (
                        <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500">
                          Embedding
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {model.provider} · {model.apiModelId} ·{" "}
                      {model.contextWindow.toLocaleString()} tokens
                    </p>
                  </div>
                  <div className="flex gap-2 text-xs text-muted-foreground">
                    <span>
                      {model.capabilities.toolCalls ? "Tools" : "No tools"}
                    </span>
                    <span>
                      {model.capabilities.vision ? "Vision" : "No vision"}
                    </span>
                    <span>
                      {model.capabilities.structuredOutput ? "JSON" : "No JSON"}
                    </span>
                  </div>
                  <Button
                    aria-label={`Edit ${model.name}`}
                    size="sm"
                    variant="ghost"
                    onClick={() => editModel(model)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={async () => {
                      if (confirm(`Delete ${model.name}?`)) {
                        await request(
                          `/api/admin/model-settings/models/${model.id}`,
                          { method: "DELETE" },
                        );
                        await load();
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
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
function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
