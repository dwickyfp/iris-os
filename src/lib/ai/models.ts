import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { EmbeddingModel, LanguageModel } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { createOllama } from "ollama-ai-provider-v2";

import { ChatModel } from "app-types/chat";
import {
  ModelCapabilities,
  ModelCatalogItem,
  type SystemModelEngineKey,
} from "app-types/model-settings";
import { pgDb } from "lib/db/pg/db.pg";
import {
  ModelConfigurationTable,
  ModelEngineAssignmentTable,
  ModelProviderTable,
} from "lib/db/pg/schema.pg";
import { decryptSecret } from "lib/model-settings/crypto";
import { createAzureOpenAICompatible } from "./azure-openai-compatible";
import {
  SYSTEM_MODEL_ENGINES,
  getSystemModelEngine,
  resolveSystemEngineModels,
  type SystemModelEngineDefinition,
} from "./system-model-engines";

export type ConfiguredModel = ModelCatalogItem & {
  apiModelId: string;
  apiVersion: string | null;
  providerType: string;
  baseUrl: string | null;
  encryptedApiKey: string | null;
  modelKind: "chat" | "embedding";
  isCurator: boolean;
  isEmbeddingDefault: boolean;
  embeddingDimensions: number | null;
  enabled: boolean;
  providerEnabled: boolean;
};

const capabilityDefaults: ModelCapabilities = {
  toolCalls: true,
  vision: false,
  structuredOutput: true,
};

async function configuredModels(
  activeOnly = true,
  modelKind?: "chat" | "embedding",
): Promise<ConfiguredModel[]> {
  const conditions = activeOnly
    ? and(
        eq(ModelProviderTable.enabled, true),
        eq(ModelConfigurationTable.enabled, true),
        modelKind
          ? eq(ModelConfigurationTable.modelKind, modelKind)
          : undefined,
      )
    : modelKind
      ? eq(ModelConfigurationTable.modelKind, modelKind)
      : undefined;
  const rows = await pgDb
    .select({ provider: ModelProviderTable, model: ModelConfigurationTable })
    .from(ModelConfigurationTable)
    .innerJoin(
      ModelProviderTable,
      eq(ModelConfigurationTable.providerId, ModelProviderTable.id),
    )
    .where(conditions)
    .orderBy(asc(ModelProviderTable.name), asc(ModelConfigurationTable.name));

  return rows.map(({ provider, model }) => ({
    id: model.id,
    provider: provider.name,
    model: model.name,
    apiModelId: model.apiModelId,
    apiVersion: model.apiVersion,
    providerType: provider.type,
    baseUrl: provider.baseUrl,
    encryptedApiKey: provider.encryptedApiKey,
    modelKind: model.modelKind,
    isCurator: model.isCurator,
    isEmbeddingDefault: model.isEmbeddingDefault,
    embeddingDimensions: model.embeddingDimensions,
    enabled: model.enabled,
    providerEnabled: provider.enabled,
    contextWindow: model.contextWindow,
    capabilities: {
      ...capabilityDefaults,
      ...(model.capabilities as Partial<ModelCapabilities>),
    },
    isDefault: model.isDefault,
  }));
}

export async function getModelCatalog() {
  const models = await configuredModels(true, "chat");
  return models
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    )
    .reduce<
      {
        provider: string;
        hasAPIKey: boolean;
        models: Array<{
          id: string;
          name: string;
          isToolCallUnsupported: boolean;
          isImageInputUnsupported: boolean;
          isStructuredOutputUnsupported: boolean;
          supportedFileMimeTypes: string[];
          contextWindow: number;
          capabilities: ModelCapabilities;
          isDefault: boolean;
        }>;
      }[]
    >((providers, model) => {
      let provider = providers.find((item) => item.provider === model.provider);
      if (!provider) {
        provider = {
          provider: model.provider,
          hasAPIKey:
            Boolean(model.encryptedApiKey) || model.providerType === "ollama",
          models: [],
        };
        providers.push(provider);
      }
      provider.models.push({
        id: model.id,
        name: model.model,
        isToolCallUnsupported: !model.capabilities.toolCalls,
        isImageInputUnsupported: !model.capabilities.vision,
        isStructuredOutputUnsupported: !model.capabilities.structuredOutput,
        supportedFileMimeTypes: model.capabilities.vision
          ? [
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/gif",
              "application/pdf",
            ]
          : [],
        contextWindow: model.contextWindow,
        capabilities: model.capabilities,
        isDefault: model.isDefault,
      });
      return providers;
    }, []);
}

export async function getModelConfiguration(model?: ChatModel) {
  const models = await configuredModels(true, "chat");
  const configured = model
    ? models.find(
        (item) =>
          item.provider === model.provider && item.model === model.model,
      )
    : (models.find((item) => item.isDefault) ?? models[0]);
  if (!configured) throw new Error("No enabled model has been configured");
  return configured;
}

export async function getCuratorModelConfiguration() {
  return getEngineModelConfiguration("memory-curator");
}

export async function getEmbeddingModelConfiguration() {
  return getEngineModelConfiguration("memory-embedding");
}

type EngineResolution = {
  engine: SystemModelEngineDefinition;
  assignedModelId: string | null;
  effective: ConfiguredModel | null;
  candidates: ConfiguredModel[];
  isFallback: boolean;
  warning: string | null;
};

function resolveSystemEngine(
  engine: SystemModelEngineDefinition,
  allModels: ConfiguredModel[],
  assignedModelId: string | null,
): EngineResolution {
  const { assignedIsUsable, candidates, effective } =
    resolveSystemEngineModels(engine, allModels, assignedModelId);
  const warning = assignedIsUsable
    ? null
    : assignedModelId
      ? effective
        ? `Assigned model is unavailable or incompatible; using ${effective.provider}/${effective.model}.`
        : "Assigned model is unavailable or incompatible, and no fallback is configured."
      : effective
        ? `No model is assigned; using ${effective.provider}/${effective.model}.`
        : "No compatible model is configured.";
  return {
    engine,
    assignedModelId,
    effective,
    candidates,
    isFallback: !assignedIsUsable,
    warning,
  };
}

async function loadEngineResolutions() {
  const [models, assignments] = await Promise.all([
    configuredModels(false),
    pgDb.select().from(ModelEngineAssignmentTable),
  ]);
  const assigned = new Map(
    assignments.map((assignment) => [
      assignment.engineKey,
      assignment.modelId,
    ]),
  );
  return SYSTEM_MODEL_ENGINES.map((engine) =>
    resolveSystemEngine(engine, models, assigned.get(engine.key) ?? null),
  );
}

export async function getEngineModelConfiguration(
  engineKey: SystemModelEngineKey,
) {
  const engine = getSystemModelEngine(engineKey);
  const [assignment] = await pgDb
    .select({ modelId: ModelEngineAssignmentTable.modelId })
    .from(ModelEngineAssignmentTable)
    .where(eq(ModelEngineAssignmentTable.engineKey, engineKey))
    .limit(1);
  const resolution = resolveSystemEngine(
    engine,
    await configuredModels(false),
    assignment?.modelId ?? null,
  );
  if (resolution.warning)
    console.warn(
      JSON.stringify({
        event: "system_model_engine_fallback",
        engineKey,
        warning: resolution.warning,
      }),
    );
  if (!resolution.effective)
    throw new Error(
      `No enabled compatible model is configured for ${engine.key}`,
    );
  return resolution.effective;
}

function publicModel(model: ConfiguredModel) {
  return {
    id: model.id,
    provider: model.provider,
    name: model.model,
    modelKind: model.modelKind,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
  };
}

export async function getSystemModelEngineSettings() {
  return (await loadEngineResolutions()).map((resolution) => ({
    ...resolution.engine,
    assignedModelId: resolution.assignedModelId,
    effectiveModel: resolution.effective
      ? publicModel(resolution.effective)
      : null,
    candidates: resolution.candidates.map(publicModel),
    isFallback: resolution.isFallback,
    warning: resolution.warning,
  }));
}

function createLanguageModel(config: ConfiguredModel): LanguageModel {
  const apiKey = config.encryptedApiKey
    ? decryptSecret(config.encryptedApiKey)
    : undefined;
  const options = {
    apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  };
  switch (config.providerType) {
    case "openai":
      return createOpenAI(options)(config.apiModelId);
    case "anthropic":
      return createAnthropic(options)(config.apiModelId);
    case "google":
      return createGoogle(options)(config.apiModelId);
    case "xai":
      return createXai(options)(config.apiModelId);
    case "groq":
      return createGroq(options)(config.apiModelId);
    case "openrouter":
      return createOpenRouter(options)(config.apiModelId);
    case "ollama":
      return createOllama({
        baseURL: config.baseUrl || "http://localhost:11434/api",
      })(config.apiModelId);
    case "azure-openai": {
      if (!config.baseUrl || !config.apiVersion)
        throw new Error("Azure OpenAI requires an endpoint and API version");
      return createAzureOpenAICompatible({
        name: config.provider,
        apiKey: apiKey || "",
        baseURL: config.baseUrl,
      })(config.apiModelId, config.apiVersion);
    }
    case "openai-compatible":
      if (!config.baseUrl)
        throw new Error("OpenAI-compatible providers require an endpoint");
      return createOpenAICompatible({
        name: config.provider,
        apiKey: apiKey || "",
        baseURL: config.baseUrl,
      })(config.apiModelId);
    default:
      throw new Error(`Unsupported provider type: ${config.providerType}`);
  }
}

function createEmbeddingModel(config: ConfiguredModel): EmbeddingModel {
  const apiKey = config.encryptedApiKey
    ? decryptSecret(config.encryptedApiKey)
    : undefined;
  const options = {
    apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  };
  switch (config.providerType) {
    case "openai":
      return createOpenAI(options).textEmbeddingModel(config.apiModelId);
    case "google":
      return createGoogle(options).textEmbeddingModel(config.apiModelId);
    case "ollama":
      return createOllama({
        baseURL: config.baseUrl || "http://localhost:11434/api",
      }).textEmbeddingModel(config.apiModelId);
    case "openai-compatible":
      if (!config.baseUrl)
        throw new Error("OpenAI-compatible providers require an endpoint");
      return createOpenAICompatible({
        name: config.provider,
        apiKey: apiKey || "",
        baseURL: config.baseUrl,
      }).textEmbeddingModel(config.apiModelId);
    default:
      throw new Error(
        `Provider ${config.providerType} does not support memory embeddings`,
      );
  }
}

export const customModelProvider = {
  getModel: async (model?: ChatModel) =>
    createLanguageModel(await getModelConfiguration(model)),
  getCuratorModel: async () => {
    const config = await getCuratorModelConfiguration();
    if (!config) throw new Error("No enabled curator model configured");
    return createLanguageModel(config);
  },
  getEngineModel: async (engineKey: SystemModelEngineKey) => {
    const config = await getEngineModelConfiguration(engineKey);
    if (config.modelKind !== "chat")
      throw new Error(`${engineKey} is not a language-model engine`);
    return createLanguageModel(config);
  },
  getEmbeddingModel: async () => {
    const config = await getEmbeddingModelConfiguration();
    if (!config) return undefined;
    return {
      model: createEmbeddingModel(config),
      modelId: config.apiModelId,
      dimensions: config.embeddingDimensions,
    };
  },
  getModelConfiguration,
  getModelCatalog,
};
