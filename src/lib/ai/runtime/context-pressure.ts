import type { UIMessage } from "ai";

const DEFAULT_COMPACT_AT = 0.8;
const DEFAULT_PRUNE_AT = 0.95;
const CHARACTERS_PER_TOKEN = 4;

export type ContextPressureAction = "none" | "compact" | "prune" | "reject";

export type ContextPressureContext = {
  trustedInstructions?: string;
  instructions: string;
  messages: UIMessage[];
};

export type ContextPressureComponent = {
  id: string;
  category: string;
  estimatedTokens?: number;
  value?: unknown;
  priority?: number;
};

export type ContextPressureCategories = {
  instructions: number;
  messages: number;
  toolSchema: number;
  reservedOutput: number;
};

export type ContextPressureDiagnostics = {
  estimator: "character_heuristic_v1";
  contextWindow: number;
  availableInputTokens: number;
  categories: ContextPressureCategories;
  componentTokens: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
  projectedTokens: number;
  requiredTokens: number;
  overflowTokens: number;
  pressureRatio: number;
  missingRequiredCategories: string[];
};

export type ContextPressureInput<Context extends ContextPressureContext> = {
  context: Context;
  contextWindow: number;
  reservedOutputTokens?: number;
  toolSchemas?: unknown;
  components?: ContextPressureComponent[];
  requiredCategories?: readonly string[];
};

export type ContextPressureResult<Context extends ContextPressureContext> = {
  context: Context;
  action: ContextPressureAction;
  keptComponentIds: string[];
  prunedComponentIds: string[];
  diagnostics: ContextPressureDiagnostics;
};

export type ContextPressureManagerOptions = {
  compactAt?: number;
  pruneAt?: number;
};

function stableSerialize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

/** Provider-neutral estimate used until a model tokenizer is supplied. */
export function estimateContextTokens(value: unknown): number {
  const serialized = stableSerialize(value);
  return serialized.length === 0
    ? 0
    : Math.ceil(serialized.length / CHARACTERS_PER_TOKEN);
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function componentTokens(component: ContextPressureComponent): number {
  return component.estimatedTokens === undefined
    ? estimateContextTokens(component.value)
    : nonNegativeInteger(
        component.estimatedTokens,
        `estimatedTokens for ${component.id}`,
      );
}

/**
 * Adds pressure accounting and deterministic action selection around any
 * ContextEngine-compatible output. It does not mutate or replace that output.
 */
export class ContextPressureManager {
  private readonly compactAt: number;
  private readonly pruneAt: number;

  constructor(options: ContextPressureManagerOptions = {}) {
    this.compactAt = options.compactAt ?? DEFAULT_COMPACT_AT;
    this.pruneAt = options.pruneAt ?? DEFAULT_PRUNE_AT;
    if (
      !Number.isFinite(this.compactAt) ||
      !Number.isFinite(this.pruneAt) ||
      this.compactAt < 0 ||
      this.compactAt >= this.pruneAt ||
      this.pruneAt > 1
    ) {
      throw new RangeError(
        "pressure thresholds must satisfy 0 <= compactAt < pruneAt <= 1",
      );
    }
  }

  assess<Context extends ContextPressureContext>(
    input: ContextPressureInput<Context>,
  ): ContextPressureResult<Context> {
    const contextWindow = nonNegativeInteger(
      input.contextWindow,
      "contextWindow",
    );
    if (contextWindow === 0) {
      throw new RangeError("contextWindow must be greater than zero");
    }
    const reservedOutput = nonNegativeInteger(
      input.reservedOutputTokens ?? 0,
      "reservedOutputTokens",
    );
    const instructions =
      input.context.trustedInstructions ?? input.context.instructions;
    const categories: ContextPressureCategories = {
      instructions: estimateContextTokens(instructions),
      messages: estimateContextTokens(input.context.messages),
      toolSchema: estimateContextTokens(input.toolSchemas),
      reservedOutput,
    };
    const components = (input.components ?? []).map((component) => ({
      ...component,
      tokens: componentTokens(component),
      priority: component.priority ?? 0,
    }));
    if (new Set(components.map(({ id }) => id)).size !== components.length) {
      throw new Error("context pressure component ids must be unique");
    }

    const requiredCategories = new Set(input.requiredCategories ?? []);
    const presentCategories = new Set(
      components.map(({ category }) => category),
    );
    const missingRequiredCategories = [...requiredCategories]
      .filter((category) => !presentCategories.has(category))
      .sort();
    const baseInputTokens =
      categories.instructions + categories.messages + categories.toolSchema;
    const componentTokenTotal = components.reduce(
      (sum, component) => sum + component.tokens,
      0,
    );
    const estimatedInputTokens = baseInputTokens + componentTokenTotal;
    const estimatedTotalTokens = estimatedInputTokens + reservedOutput;
    const requiredComponentTokens = components
      .filter(({ category }) => requiredCategories.has(category))
      .reduce((sum, component) => sum + component.tokens, 0);
    const requiredTokens =
      baseInputTokens + reservedOutput + requiredComponentTokens;
    const kept = new Set(components.map(({ id }) => id));
    const prunedComponentIds: string[] = [];
    let projectedTokens = estimatedTotalTokens;

    if (estimatedTotalTokens > contextWindow) {
      const candidates = components
        .filter(({ category }) => !requiredCategories.has(category))
        .sort(
          (left, right) =>
            left.priority - right.priority || left.id.localeCompare(right.id),
        );
      for (const candidate of candidates) {
        if (projectedTokens <= contextWindow) break;
        kept.delete(candidate.id);
        prunedComponentIds.push(candidate.id);
        projectedTokens -= candidate.tokens;
      }
    }

    const cannotFit =
      projectedTokens > contextWindow || missingRequiredCategories.length > 0;
    const pressureRatio = estimatedTotalTokens / contextWindow;
    let action: ContextPressureAction = "none";
    if (cannotFit) action = "reject";
    else if (estimatedTotalTokens > contextWindow) action = "prune";
    else if (pressureRatio >= this.pruneAt) action = "prune";
    else if (pressureRatio >= this.compactAt) action = "compact";

    return {
      context: input.context,
      action,
      keptComponentIds: components
        .filter(({ id }) => kept.has(id))
        .map(({ id }) => id),
      prunedComponentIds,
      diagnostics: {
        estimator: "character_heuristic_v1",
        contextWindow,
        availableInputTokens: Math.max(0, contextWindow - reservedOutput),
        categories,
        componentTokens: componentTokenTotal,
        estimatedInputTokens,
        estimatedTotalTokens,
        projectedTokens,
        requiredTokens,
        overflowTokens: Math.max(0, projectedTokens - contextWindow),
        pressureRatio,
        missingRequiredCategories,
      },
    };
  }
}

export type ContextOverflowRecoveryAction = "compact" | "prune";

export type ContextOverflowRecoveryInput = {
  action: ContextOverflowRecoveryAction;
  attempt: number;
  error: unknown;
};

export async function retryContextOverflow<Result>(input: {
  operation(attempt: number): Promise<Result>;
  recover(input: ContextOverflowRecoveryInput): Promise<void>;
  isOverflowError(error: unknown): boolean;
}): Promise<Result> {
  const recoveryActions: readonly ContextOverflowRecoveryAction[] = [
    "compact",
    "prune",
  ];

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.operation(attempt);
    } catch (error) {
      const action = recoveryActions[attempt];
      if (!action || !input.isOverflowError(error)) throw error;
      await input.recover({ action, attempt: attempt + 1, error });
    }
  }
}
