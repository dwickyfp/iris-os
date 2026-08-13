import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { LanguageModel } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { createOllama } from "ollama-ai-provider-v2";

import { ChatModel } from "app-types/chat";
import { ModelCapabilities, ModelCatalogItem } from "app-types/model-settings";
import { pgDb } from "lib/db/pg/db.pg";
import {
  ModelConfigurationTable,
  ModelProviderTable,
} from "lib/db/pg/schema.pg";
import { decryptSecret } from "lib/model-settings/crypto";
import { createAzureOpenAICompatible } from "./azure-openai-compatible";

type ConfiguredModel = ModelCatalogItem & {
  apiModelId: string;
  apiVersion: string | null;
  providerType: string;
  baseUrl: string | null;
  encryptedApiKey: string | null;
};

const capabilityDefaults: ModelCapabilities = {
  toolCalls: true,
  vision: false,
  structuredOutput: true,
};

async function configuredModels(activeOnly = true): Promise<ConfiguredModel[]> {
  const conditions = activeOnly
    ? and(
        eq(ModelProviderTable.enabled, true),
        eq(ModelConfigurationTable.enabled, true),
      )
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
    contextWindow: model.contextWindow,
    capabilities: {
      ...capabilityDefaults,
      ...(model.capabilities as Partial<ModelCapabilities>),
    },
    isDefault: model.isDefault,
  }));
}

export async function getModelCatalog() {
  const models = await configuredModels();
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
  const models = await configuredModels();
  const configured = model
    ? models.find(
        (item) =>
          item.provider === model.provider && item.model === model.model,
      )
    : (models.find((item) => item.isDefault) ?? models[0]);
  if (!configured) throw new Error("No enabled model has been configured");
  return configured;
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

export const customModelProvider = {
  getModel: async (model?: ChatModel) =>
    createLanguageModel(await getModelConfiguration(model)),
  getModelConfiguration,
  getModelCatalog,
};
