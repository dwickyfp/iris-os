import type { CapabilityHealthStatus } from "app-types/capability-health";
import type { CapabilityDescriptor } from "./registry";

export type CapabilitySearchDocument = {
  id: string;
  key: string;
  kind: CapabilityDescriptor["kind"];
  name: string;
  description: string;
  aliases: string[];
  provider: string[];
  skills: string[];
  tokens: string[];
  healthTier: number;
};

export type CapabilityRouterConfig = {
  threshold: number;
  topN: number;
  minScore: number;
  timeoutMs: number;
  fallbackHardCap: number;
};

export type CapabilityRoutingDiagnostics = {
  event: "capability.routing";
  strategy: "preserve-all" | "stage1-lexical" | "fallback" | "only";
  candidateCount: number;
  selectedCount: number;
  threshold: number;
  topN: number;
  fallbackHardCap: number;
  minScore: number;
  elapsedMs: number;
  reductionRate: number;
  signal: "not-evaluated" | "sufficient" | "low" | "degraded";
  clarificationRequired: boolean;
  pinnedIds: string[];
  selectedIds: string[];
  scores: Array<{ id: string; score: number }>;
  fallbackReason?: "empty_query" | "low_signal" | "timeout" | "scoring_error";
};

export const DEFAULT_CAPABILITY_ROUTER_CONFIG: CapabilityRouterConfig = {
  threshold: 20,
  topN: 12,
  minScore: 0.15,
  timeoutMs: 25,
  fallbackHardCap: 100,
};

type RouterOptions = {
  config?: Partial<CapabilityRouterConfig>;
  now?: () => number;
};

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export function tokenizeCapabilityText(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(TOKEN_PATTERN) ?? [];
}

export function capabilitySearchDocument(
  descriptor: CapabilityDescriptor,
  providerName?: string,
): CapabilitySearchDocument {
  const aliases = [...(descriptor.search?.aliases ?? [])];
  const provider = [
    providerName,
    ...(descriptor.search?.provider ?? []),
  ].filter((value): value is string => Boolean(value));
  const skills = [...(descriptor.search?.skills ?? [])];
  const description = descriptor.description ?? "";
  const weightedText = [
    descriptor.name,
    descriptor.name,
    descriptor.key,
    ...aliases,
    ...aliases,
    description,
    ...provider,
    ...skills,
    ...skills,
  ].join(" ");

  return {
    id: descriptor.id,
    key: descriptor.key,
    kind: descriptor.kind,
    name: descriptor.name,
    description,
    aliases,
    provider,
    skills,
    tokens: tokenizeCapabilityText(weightedText),
    healthTier: capabilityHealthTier(descriptor.health?.status),
  };
}

export function routeCapabilityDocuments(
  documents: readonly CapabilitySearchDocument[],
  query: string,
  pinnedIds: ReadonlySet<string> = new Set(),
  options: RouterOptions = {},
): {
  selectedIds: string[];
  diagnostics: CapabilityRoutingDiagnostics;
} {
  const config = normalizeConfig(options.config);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const pinned = documents.filter((document) => pinnedIds.has(document.id));
  const boundedCount = Math.max(config.topN, pinned.length);

  if (documents.length <= config.threshold) {
    return {
      selectedIds: documents.map(({ id }) => id),
      diagnostics: diagnostics({
        strategy: "preserve-all",
        documents,
        selected: documents,
        pinned,
        config,
        startedAt,
        now,
        scores: [],
        signal: "not-evaluated",
      }),
    };
  }

  const fallback = (
    reason: NonNullable<CapabilityRoutingDiagnostics["fallbackReason"]>,
  ) => {
    const preserveAll = documents.length <= config.fallbackHardCap;
    const selected = preserveAll
      ? uniqueDocuments([...pinned, ...documents])
      : pinned;
    return {
      selectedIds: selected.map(({ id }) => id),
      diagnostics: diagnostics({
        strategy: "fallback",
        reason,
        documents,
        selected,
        pinned,
        config,
        startedAt,
        now,
        scores: [],
        signal: reason === "timeout" ? "degraded" : "low",
        clarificationRequired: !preserveAll,
      }),
    };
  };

  const queryTokens = [...new Set(tokenizeCapabilityText(query))];
  if (queryTokens.length === 0) return fallback("empty_query");

  try {
    const documentFrequency = new Map<string, number>();
    for (const document of documents) {
      assertWithinDeadline(startedAt, config.timeoutMs, now);
      for (const token of new Set(document.tokens)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
    const averageLength =
      documents.reduce((sum, document) => sum + document.tokens.length, 0) /
      Math.max(documents.length, 1);
    const scores = documents.map((document, index) => {
      assertWithinDeadline(startedAt, config.timeoutMs, now);
      const frequencies = new Map<string, number>();
      for (const token of document.tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
      const score = queryTokens.reduce((total, token) => {
        const frequency = frequencies.get(token) ?? 0;
        if (frequency === 0) return total;
        const documentCount = documents.length;
        const containing = documentFrequency.get(token) ?? 0;
        const inverseFrequency = Math.log(
          1 + (documentCount - containing + 0.5) / (containing + 0.5),
        );
        const lengthRatio = document.tokens.length / Math.max(averageLength, 1);
        const termWeight =
          (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * lengthRatio));
        return total + inverseFrequency * termWeight;
      }, 0);
      return { document, index, score };
    });
    scores.sort(
      (a, b) =>
        b.score - a.score ||
        a.document.healthTier - b.document.healthTier ||
        a.index - b.index,
    );
    const relevant = scores
      .filter(({ score }) => score >= config.minScore)
      .map(({ document }) => document);
    if (relevant.length === 0) return fallback("low_signal");
    const selected = uniqueDocuments([...pinned, ...relevant]).slice(
      0,
      boundedCount,
    );

    return {
      selectedIds: selected.map(({ id }) => id),
      diagnostics: diagnostics({
        strategy: "stage1-lexical",
        documents,
        selected,
        pinned,
        config,
        startedAt,
        now,
        scores: scores
          .filter(({ score }) => score > 0)
          .slice(0, config.topN)
          .map(({ document, score }) => ({
            id: document.id,
            score: Number(score.toFixed(6)),
          })),
        signal: "sufficient",
      }),
    };
  } catch (error) {
    return fallback(
      error instanceof RoutingTimeoutError ? "timeout" : "scoring_error",
    );
  }
}

function capabilityHealthTier(status?: CapabilityHealthStatus) {
  switch (status) {
    case "healthy":
      return 0;
    case "degraded":
      return 1;
    case "auth_required":
      return 2;
    default:
      return 3;
  }
}

function normalizeConfig(
  input: Partial<CapabilityRouterConfig> | undefined,
): CapabilityRouterConfig {
  return {
    threshold: positiveInteger(
      input?.threshold,
      DEFAULT_CAPABILITY_ROUTER_CONFIG.threshold,
    ),
    topN: positiveInteger(input?.topN, DEFAULT_CAPABILITY_ROUTER_CONFIG.topN),
    minScore:
      typeof input?.minScore === "number" && input.minScore >= 0
        ? input.minScore
        : DEFAULT_CAPABILITY_ROUTER_CONFIG.minScore,
    timeoutMs: positiveInteger(
      input?.timeoutMs,
      DEFAULT_CAPABILITY_ROUTER_CONFIG.timeoutMs,
    ),
    fallbackHardCap: positiveInteger(
      input?.fallbackHardCap,
      DEFAULT_CAPABILITY_ROUTER_CONFIG.fallbackHardCap,
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function uniqueDocuments(documents: readonly CapabilitySearchDocument[]) {
  return [
    ...new Map(documents.map((document) => [document.id, document])).values(),
  ];
}

class RoutingTimeoutError extends Error {}

function assertWithinDeadline(
  startedAt: number,
  timeoutMs: number,
  now: () => number,
) {
  if (now() - startedAt > timeoutMs) throw new RoutingTimeoutError();
}

function diagnostics(input: {
  strategy: CapabilityRoutingDiagnostics["strategy"];
  reason?: CapabilityRoutingDiagnostics["fallbackReason"];
  documents: readonly CapabilitySearchDocument[];
  selected: readonly CapabilitySearchDocument[];
  pinned: readonly CapabilitySearchDocument[];
  config: CapabilityRouterConfig;
  startedAt: number;
  now: () => number;
  scores: CapabilityRoutingDiagnostics["scores"];
  signal: CapabilityRoutingDiagnostics["signal"];
  clarificationRequired?: boolean;
}): CapabilityRoutingDiagnostics {
  return {
    event: "capability.routing",
    strategy: input.strategy,
    candidateCount: input.documents.length,
    selectedCount: input.selected.length,
    threshold: input.config.threshold,
    topN: input.config.topN,
    fallbackHardCap: input.config.fallbackHardCap,
    minScore: input.config.minScore,
    elapsedMs: Math.max(0, input.now() - input.startedAt),
    reductionRate:
      input.documents.length === 0
        ? 0
        : Number(
            (1 - input.selected.length / input.documents.length).toFixed(6),
          ),
    signal: input.signal,
    clarificationRequired: input.clarificationRequired ?? false,
    pinnedIds: input.pinned.map(({ id }) => id),
    selectedIds: input.selected.map(({ id }) => id),
    scores: input.scores,
    ...(input.reason ? { fallbackReason: input.reason } : {}),
  };
}
