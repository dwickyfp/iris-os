import type {
  ModelCapabilities,
  SystemModelEngineKey,
} from "app-types/model-settings";

export type SystemModelEngineDefinition = {
  key: SystemModelEngineKey;
  label: string;
  description: string;
  category: "background" | "auxiliary" | "vector";
  modelKind: "chat" | "embedding";
  requiredCapabilities: Partial<ModelCapabilities>;
};

export const SYSTEM_MODEL_ENGINES: readonly SystemModelEngineDefinition[] = [
  {
    key: "memory-curator",
    label: "Memory Curator",
    description:
      "Reviews completed turns, atomizes durable claims, and consolidates memory lineage.",
    category: "background",
    modelKind: "chat",
    requiredCapabilities: { toolCalls: true, structuredOutput: true },
  },
  {
    key: "automation-runner",
    label: "Automation Runner",
    description: "Runs headless skills and agents started by durable automations.",
    category: "background",
    modelKind: "chat",
    requiredCapabilities: { toolCalls: true },
  },
  {
    key: "delegation-runner",
    label: "Delegation Runner",
    description: "Runs delegated child agents outside the foreground chat.",
    category: "background",
    modelKind: "chat",
    requiredCapabilities: { toolCalls: true },
  },
  {
    key: "context-summary",
    label: "Context Summary",
    description:
      "Summarizes older messages when a conversation approaches its context limit.",
    category: "auxiliary",
    modelKind: "chat",
    requiredCapabilities: {},
  },
  {
    key: "thread-title",
    label: "Thread Title",
    description: "Generates a short title for a newly created conversation.",
    category: "auxiliary",
    modelKind: "chat",
    requiredCapabilities: {},
  },
  {
    key: "memory-embedding",
    label: "Memory Embedding",
    description: "Creates vectors used by memory search and graph recall.",
    category: "vector",
    modelKind: "embedding",
    requiredCapabilities: {},
  },
] as const;

export function getSystemModelEngine(engineKey: SystemModelEngineKey) {
  const engine = SYSTEM_MODEL_ENGINES.find((item) => item.key === engineKey);
  if (!engine) throw new Error(`Unknown system model engine: ${engineKey}`);
  return engine;
}

export function isSystemEngineModelCompatible(
  engine: SystemModelEngineDefinition,
  model: {
    modelKind: "chat" | "embedding";
    capabilities: ModelCapabilities;
  },
) {
  if (model.modelKind !== engine.modelKind) return false;
  return Object.entries(engine.requiredCapabilities).every(
    ([capability, required]) =>
      !required || model.capabilities[capability as keyof ModelCapabilities],
  );
}

export function resolveSystemEngineModels<
  T extends {
    id: string;
    modelKind: "chat" | "embedding";
    capabilities: ModelCapabilities;
    enabled: boolean;
    providerEnabled: boolean;
    isDefault: boolean;
  },
>(
  engine: SystemModelEngineDefinition,
  models: T[],
  assignedModelId: string | null,
) {
  const assigned = assignedModelId
    ? models.find((model) => model.id === assignedModelId)
    : undefined;
  const candidates = models.filter(
    (model) =>
      model.enabled &&
      model.providerEnabled &&
      isSystemEngineModelCompatible(engine, model),
  );
  const assignedIsUsable = Boolean(
    assigned &&
      assigned.enabled &&
      assigned.providerEnabled &&
      isSystemEngineModelCompatible(engine, assigned),
  );
  const effective = assignedIsUsable
    ? (assigned ?? null)
    : (candidates.find((model) => model.isDefault) ?? candidates[0] ?? null);
  return { assigned, assignedIsUsable, candidates, effective };
}
