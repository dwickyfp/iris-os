import type { ArtifactReference } from "../artifacts/contracts";

export type ResultSurfaceMode =
  | "inline"
  | "pruned"
  | "structured-summary"
  | "reference";

export type ResultTrust = "trusted" | "untrusted" | "mixed";

export type ResultOwnership = {
  userId: string;
  runId?: string;
  workspaceId?: string;
  taskId?: string;
  agentId?: string;
};

export type ResultProvenance = {
  sourceId: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
};

export type ResultSource = {
  id: string;
  content: string;
  mediaType?: string;
  ownership: ResultOwnership;
  trust: ResultTrust;
  provenance: ResultProvenance[];
};

export type ResultStoreLocation = {
  key: string;
  uri?: string;
  artifact?: ArtifactReference;
};

export interface ResultSurfaceStore {
  put(source: ResultSource): Promise<ResultStoreLocation>;
}

export type ResultRef = {
  id: string;
  key: string;
  uri?: string;
  artifact?: ArtifactReference;
  mediaType: string;
  byteLength: number;
  estimatedTokens: number;
  ownership: ResultOwnership;
  trust: ResultTrust;
  provenance: ResultProvenance[];
};

export type ResultThreshold = {
  maxBytes: number;
  maxTokens: number;
};

export type ResultSurfaceThresholds = {
  inline: ResultThreshold;
  pruned: ResultThreshold;
  structuredSummary: ResultThreshold;
};

export type StructuredResultSummary = {
  format: "result-summary-v1";
  source: {
    mediaType: string;
    byteLength: number;
    estimatedTokens: number;
  };
  structure:
    | { type: "array"; length: number; sample: StructuredJsonSample[] }
    | { type: "object"; keys: string[]; keyCount: number }
    | { type: "string"; characterLength: number }
    | { type: "scalar"; value: unknown }
    | { type: "invalid-json" };
  preview: { head: string; tail: string };
};

export type StructuredJsonSample =
  | string
  | number
  | boolean
  | null
  | { type: "string"; characterLength: number; preview: string }
  | { type: "array"; length: number }
  | { type: "object"; keys: string[]; keyCount: number };

type ResultSurfaceCommon = {
  ref: ResultRef;
  ownership: ResultOwnership;
  trust: ResultTrust;
  provenance: ResultProvenance[];
};

export type ResultSurface = ResultSurfaceCommon &
  (
    | { mode: "inline"; content: string }
    | { mode: "pruned"; content: string; omittedBytes: number }
    | { mode: "structured-summary"; summary: StructuredResultSummary }
    | { mode: "reference" }
  );

export type ResultSurfaceManagerOptions = {
  thresholds?: {
    inline?: Partial<ResultThreshold>;
    pruned?: Partial<ResultThreshold>;
    structuredSummary?: Partial<ResultThreshold>;
  };
  estimateTokens?: (content: string) => number;
};

const DEFAULT_THRESHOLDS: ResultSurfaceThresholds = {
  inline: { maxBytes: 8_000, maxTokens: 2_000 },
  pruned: { maxBytes: 32_000, maxTokens: 8_000 },
  structuredSummary: { maxBytes: 128_000, maxTokens: 32_000 },
};

const PRUNED_MARKER = "\n\n[... result pruned ...]\n\n";
const PREVIEW_BYTES = 96;
const SUMMARY_KEY_CHARACTERS = 120;

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function byteHead(value: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(value);
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}

function byteTail(value: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(value);
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.slice(start));
}

function within(
  threshold: ResultThreshold,
  bytes: number,
  estimatedTokens: number,
) {
  return bytes <= threshold.maxBytes && estimatedTokens <= threshold.maxTokens;
}

function validateThresholds(thresholds: ResultSurfaceThresholds) {
  const ordered = [
    thresholds.inline,
    thresholds.pruned,
    thresholds.structuredSummary,
  ];
  for (const threshold of ordered) {
    if (threshold.maxBytes < 1 || threshold.maxTokens < 1) {
      throw new Error("Result surface thresholds must be positive");
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      current.maxBytes < previous.maxBytes ||
      current.maxTokens < previous.maxTokens
    ) {
      throw new Error("Result surface thresholds must be nondecreasing");
    }
  }
}

function resolveThresholds(
  options: ResultSurfaceManagerOptions,
): ResultSurfaceThresholds {
  const thresholds = {
    inline: { ...DEFAULT_THRESHOLDS.inline, ...options.thresholds?.inline },
    pruned: { ...DEFAULT_THRESHOLDS.pruned, ...options.thresholds?.pruned },
    structuredSummary: {
      ...DEFAULT_THRESHOLDS.structuredSummary,
      ...options.thresholds?.structuredSummary,
    },
  };
  validateThresholds(thresholds);
  return thresholds;
}

export function fitsInlineResultSurface(
  content: string,
  options: ResultSurfaceManagerOptions = {},
) {
  const thresholds = resolveThresholds(options);
  const bytes = byteLength(content);
  const estimatedTokens = Math.max(
    0,
    Math.ceil(options.estimateTokens?.(content) ?? bytes / 4),
  );
  return within(thresholds.inline, bytes, estimatedTokens);
}

function prune(content: string, maxBytes: number) {
  const markerBytes = byteLength(PRUNED_MARKER);
  const retainedBytes = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.ceil(retainedBytes / 2);
  const tailBytes = Math.floor(retainedBytes / 2);
  const totalBytes = byteLength(content);
  const head = byteHead(content, headBytes);
  const tail = byteTail(content, tailBytes);
  const projected = `${head}${PRUNED_MARKER}${tail}`;
  return {
    content: projected,
    omittedBytes: totalBytes - byteLength(head) - byteLength(tail),
  };
}

function jsonSample(value: unknown): StructuredJsonSample {
  if (typeof value === "string") {
    return value.length <= 120
      ? value
      : {
          type: "string",
          characterLength: value.length,
          preview: value.slice(0, 120),
        };
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  const keys = summaryKeys(value as object);
  return {
    type: "object",
    keys: keys.values.slice(0, 10),
    keyCount: keys.count,
  };
}

function summaryKeys(value: object) {
  const keys = Object.keys(value).sort();
  return {
    values: keys.map((key) => key.slice(0, SUMMARY_KEY_CHARACTERS)),
    count: keys.length,
  };
}

function structureOf(content: string, mediaType: string) {
  if (mediaType.includes("json")) {
    try {
      const value: unknown = JSON.parse(content);
      if (Array.isArray(value)) {
        return {
          type: "array" as const,
          length: value.length,
          sample: value.slice(0, 3).map(jsonSample),
        };
      }
      if (value !== null && typeof value === "object") {
        const keys = summaryKeys(value);
        return {
          type: "object" as const,
          keys: keys.values.slice(0, 20),
          keyCount: keys.count,
        };
      }
      return { type: "scalar" as const, value: jsonSample(value) };
    } catch {
      return { type: "invalid-json" as const };
    }
  }
  return { type: "string" as const, characterLength: content.length };
}

function summarize(
  content: string,
  mediaType: string,
  bytes: number,
  estimatedTokens: number,
): StructuredResultSummary {
  return {
    format: "result-summary-v1",
    source: { mediaType, byteLength: bytes, estimatedTokens },
    structure: structureOf(content, mediaType),
    preview: {
      head: byteHead(content, PREVIEW_BYTES),
      tail: byteTail(content, PREVIEW_BYTES),
    },
  };
}

export class ResultSurfaceManager {
  private readonly thresholds: ResultSurfaceThresholds;
  private readonly estimateTokens: (content: string) => number;

  constructor(
    private readonly store: ResultSurfaceStore,
    options: ResultSurfaceManagerOptions = {},
  ) {
    this.thresholds = resolveThresholds(options);
    this.estimateTokens =
      options.estimateTokens ??
      ((content) => Math.ceil(byteLength(content) / 4));
  }

  async project(source: ResultSource): Promise<ResultSurface> {
    const bytes = byteLength(source.content);
    const estimatedTokens = Math.max(
      0,
      Math.ceil(this.estimateTokens(source.content)),
    );
    const location = await this.store.put(source);
    const mediaType = source.mediaType ?? "text/plain";
    const common: ResultSurfaceCommon = {
      ownership: source.ownership,
      trust: source.trust,
      provenance: source.provenance,
      ref: {
        id: source.id,
        key: location.key,
        uri: location.uri,
        artifact: location.artifact,
        mediaType,
        byteLength: bytes,
        estimatedTokens,
        ownership: source.ownership,
        trust: source.trust,
        provenance: source.provenance,
      },
    };

    if (within(this.thresholds.inline, bytes, estimatedTokens)) {
      return { ...common, mode: "inline", content: source.content };
    }
    if (within(this.thresholds.pruned, bytes, estimatedTokens)) {
      return {
        ...common,
        mode: "pruned",
        ...prune(source.content, this.thresholds.inline.maxBytes),
      };
    }
    if (within(this.thresholds.structuredSummary, bytes, estimatedTokens)) {
      return {
        ...common,
        mode: "structured-summary",
        summary: summarize(source.content, mediaType, bytes, estimatedTokens),
      };
    }
    return { ...common, mode: "reference" };
  }
}
