import type {
  GoalVerificationSpec,
  PersistedVerificationLevel,
  VerificationLevel,
} from "./verification";

export type GoalCapability =
  | string
  | {
      id?: string;
      key?: string;
      name?: string;
      description?: string | null;
    };

export type NormalizedGoalRequirement = GoalVerificationSpec & {
  goal: string;
  level: VerificationLevel;
  requiredArtifactKinds: string[];
  requiredMediaTypes: string[];
  requiredSections: string[];
  requiredCapabilities: string[];
  analysisOnlyAllowed: boolean;
};

export type PersistedGoalRequirement = Omit<
  NormalizedGoalRequirement,
  "level"
> & {
  level: PersistedVerificationLevel;
};

const MEDIA_TYPES: Array<[RegExp, string]> = [
  [/\bpdf\b/i, "application/pdf"],
  [/\b(?:markdown|md)\b/i, "text/markdown"],
  [/\bjson\b/i, "application/json"],
  [/\bpng\b/i, "image/png"],
  [/\bjpe?g\b/i, "image/jpeg"],
  [/\bwebp\b/i, "image/webp"],
  [/\b(?:image|illustration|picture)\b/i, "image/*"],
];

const ARTIFACT_GOAL =
  /\b(?:create|produce|generate|write|build|export|save|deliver|make|need|want|send|attach)\b[\s\S]*\b(?:report|file|artifact|document|pdf|markdown|json|image|illustration|picture)\b|\b(?:report|file|artifact|document)\b[\s\S]*\b(?:as|in|format|download|attach)\b/i;
const OUTCOME_GOAL =
  /\b(?:analyze|analyse|evaluate|calculate|investigate|summarize|summarise|compare|assess)\b/i;

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function capture(goal: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const value = pattern.exec(goal)?.[1]?.trim();
    if (value) return value.replace(/[.?!]+$/, "").trim();
  }
}

function explicitSections(goal: string) {
  const raw = capture(goal, [
    /\bsections?\s*:\s*([^.;\n]+)/i,
    /\b(?:with|include|including)\s+(?:the\s+)?sections?\s+([^.;\n]+)/i,
  ]);
  if (!raw) return [];
  return unique(
    raw
      .split(/,|\band\b/i)
      .map((section) => section.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean),
  );
}

function capabilityName(capability: GoalCapability) {
  if (typeof capability === "string") return capability;
  return capability.key ?? capability.name ?? capability.id;
}

function mentionedCapabilities(goal: string, capabilities: GoalCapability[]) {
  const lower = goal.toLowerCase();
  return unique(
    capabilities.map((capability) => {
      const name = capabilityName(capability);
      if (!name) return;
      const aliases = unique([
        name,
        typeof capability === "object" ? capability.key : undefined,
        typeof capability === "object" ? capability.name : undefined,
      ]);
      return aliases.some((alias) =>
        lower.includes(alias.toLowerCase().replaceAll("_", " ")),
      )
        ? name
        : undefined;
    }),
  );
}

/** Cheap intent parsing only. Semantic/LLM resolution must be explicitly added. */
export class GoalRequirementResolver {
  restore(requirement: PersistedGoalRequirement): NormalizedGoalRequirement {
    return {
      ...requirement,
      level: requirement.level === "execution" ? "outcome" : requirement.level,
    };
  }

  resolve(input: {
    goal?: string;
    selectedCapabilities?: GoalCapability[];
  }): NormalizedGoalRequirement {
    const goal = input.goal?.trim() ?? "";
    if (!goal || (!ARTIFACT_GOAL.test(goal) && !OUTCOME_GOAL.test(goal))) {
      return {
        goal,
        level: "outcome",
        requiredArtifactKinds: [],
        requiredMediaTypes: [],
        requiredSections: [],
        requiredCapabilities: [],
        analysisOnlyAllowed: false,
      };
    }

    if (!ARTIFACT_GOAL.test(goal)) {
      return {
        goal,
        level: "outcome",
        requiredArtifactKinds: [],
        requiredMediaTypes: [],
        requiredSections: [],
        requiredCapabilities: [],
        analysisOnlyAllowed: true,
      };
    }

    const mediaTypes = unique(
      MEDIA_TYPES.filter(([pattern]) => pattern.test(goal)).map(([, type]) => type),
    );
    const isReport = /\breport\b/i.test(goal);
    const isImage = mediaTypes.some((type) => type.startsWith("image/"));
    const requiredCapabilities = mentionedCapabilities(
      goal,
      input.selectedCapabilities ?? [],
    );
    if (isReport) requiredCapabilities.push("generate_report");
    if (isImage) requiredCapabilities.push("image-manager");

    return {
      goal,
      level: "artifact",
      requiredArtifactKinds: unique([
        isReport ? "report" : undefined,
        isImage ? "image" : undefined,
        !isReport && !isImage ? "file" : undefined,
      ]),
      requiredMediaTypes: mediaTypes,
      requiredTitle: capture(goal, [
        /\b(?:titled|called|named)\s+["']([^"']+)["']/i,
        /\b(?:titled|called|named)\s+(.+?)(?=\s+\b(?:with|including|include|as|in)\b|[.;\n]|$)/i,
        /\btitle\s*:\s*([^.;\n]+)/i,
      ]),
      requiredPeriod: capture(goal, [
        /\b(Q[1-4](?:\s+(?:19|20)\d{2})?)\b/i,
        /\b((?:19|20)\d{2})\b/,
      ]),
      requiredSections: explicitSections(goal),
      requiredCapabilities: unique(requiredCapabilities),
      analysisOnlyAllowed: false,
    };
  }
}

export const goalRequirementResolver = new GoalRequirementResolver();
