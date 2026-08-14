import { z } from "zod";
import type { AgentIcon } from "./agent";

export const MAX_SKILL_ASSIGNMENTS = 20;
export const MAX_SKILL_FILES = 100;
export const MAX_SKILL_BODY_SIZE = 100 * 1024;
export const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_SKILL_TOTAL_FILE_SIZE = 50 * 1024 * 1024;

export const SkillVisibilitySchema = z.enum(["private", "readonly"]);
export const SkillProvenanceSchema = z.enum([
  "manual",
  "background_review",
  "generated",
  "learned",
]);
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      "Name must contain lowercase letters, numbers, and single non-edge hyphens only",
  });

const SKILL_FILE_ROOTS = new Set([
  "references",
  "scripts",
  "assets",
  "templates",
]);

export function isValidSkillFilePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;

  const segments = path.split("/");
  return (
    segments.length > 1 &&
    SKILL_FILE_ROOTS.has(segments[0]) &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    )
  );
}

export const SkillFilePathSchema = z
  .string()
  .max(1024)
  .refine(isValidSkillFilePath, {
    message:
      "File path must be a relative path under references, scripts, assets, or templates",
  });

export const SkillFileSchema = z
  .object({
    path: SkillFilePathSchema,
    content: z.string().max(MAX_SKILL_FILE_SIZE),
    mimeType: z.string().min(1).max(255),
    size: z.number().int().min(0).max(MAX_SKILL_FILE_SIZE),
  })
  .refine(
    (file) => new TextEncoder().encode(file.content).byteLength === file.size,
    {
      message: "File size must equal the UTF-8 content size",
      path: ["size"],
    },
  );

const SkillFilesSchema = z
  .array(SkillFileSchema)
  .max(MAX_SKILL_FILES)
  .superRefine((files, ctx) => {
    const paths = new Set<string>();
    let totalSize = 0;
    for (const [index, file] of files.entries()) {
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          message: "Skill file paths must be unique",
          path: [index, "path"],
        });
      }
      paths.add(file.path);
      totalSize += file.size;
    }
    if (totalSize > MAX_SKILL_TOTAL_FILE_SIZE) {
      ctx.addIssue({
        code: "custom",
        message: `Total skill file size must not exceed ${MAX_SKILL_TOTAL_FILE_SIZE} bytes`,
      });
    }
  });

const SkillFieldsSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  icon: z
    .object({
      type: z.literal("emoji"),
      value: z.string(),
      style: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  license: z.string().min(1).max(256).optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z
    .record(z.string().min(1).max(128), z.string().max(1024))
    .optional(),
  allowedTools: z.array(z.string().min(1).max(255)).max(100).optional(),
  body: z
    .string()
    .min(1)
    .refine(
      (body) =>
        new TextEncoder().encode(body).byteLength <= MAX_SKILL_BODY_SIZE,
      { message: `Body must not exceed ${MAX_SKILL_BODY_SIZE} bytes` },
    ),
  visibility: SkillVisibilitySchema,
  files: SkillFilesSchema,
});

export const SkillCreateSchema = SkillFieldsSchema.extend({
  userId: z.string(),
  visibility: SkillVisibilitySchema.optional().default("private"),
  files: SkillFilesSchema.default([]),
}).strip();

export const SkillUpdateSchema = SkillFieldsSchema.partial().strip();

export const SkillGenerateSchema = z.object({
  name: SkillNameSchema.describe(
    "A lowercase, hyphenated name with at most 64 characters",
  ),
  description: z
    .string()
    .min(1)
    .max(1024)
    .describe("A concise description of when the skill should be used"),
  compatibility: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Optional runtime or environment requirements"),
  allowedTools: z
    .array(z.string().min(1).max(255))
    .max(100)
    .default([])
    .describe("Only tools explicitly required by the user"),
  body: z
    .string()
    .min(1)
    .max(MAX_SKILL_BODY_SIZE)
    .describe("Complete SKILL.md instructions in Markdown"),
});

export const SkillQuerySchema = z.object({
  type: z.enum(["all", "mine", "shared", "bookmarked"]).default("all"),
  filters: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export type SkillVisibility = z.infer<typeof SkillVisibilitySchema>;
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;
export type SkillFile = z.infer<typeof SkillFileSchema>;
export type SkillMetadata = Record<string, string>;

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  icon?: AgentIcon;
  license?: string;
  compatibility?: string;
  metadata?: SkillMetadata;
  provenance: SkillProvenance;
  sourceCandidateId?: string;
  version?: number;
  allowedTools?: string[];
  userId: string;
  visibility: SkillVisibility;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  userName?: string;
  userAvatar?: string;
  isBookmarked?: boolean;
};

export type Skill = SkillSummary & {
  body: string;
  files: SkillFile[];
};

export type AgentSkillAssignment = SkillSummary & {
  position: number;
  files: Array<{
    path: string;
    mimeType: string;
    size: number;
  }>;
};

export type SkillRepository = {
  insertSkill(skill: z.infer<typeof SkillCreateSchema>): Promise<Skill>;
  selectSkillById(id: string, userId: string): Promise<Skill | null>;
  selectSkillsByUserId(userId: string): Promise<Skill[]>;
  updateSkill(
    id: string,
    userId: string,
    skill: z.infer<typeof SkillUpdateSchema>,
  ): Promise<Skill>;
  deleteSkill(id: string, userId: string): Promise<void>;
  archiveSkill(id: string, userId: string): Promise<Skill>;
  restoreSkill(id: string, userId: string): Promise<Skill>;
  selectSkills(
    currentUserId: string,
    filters?: ("all" | "mine" | "shared" | "bookmarked")[],
    limit?: number,
    archived?: boolean,
  ): Promise<SkillSummary[]>;
  replaceAgentSkills(
    agentId: string,
    userId: string,
    skillIds: string[],
  ): Promise<void>;
  addSkillToAgent(
    skillId: string,
    agentId: string,
    userId: string,
  ): Promise<boolean>;
  removeSkillFromAgent(
    skillId: string,
    agentId: string,
    userId: string,
  ): Promise<void>;
  selectAgentSkillAssignments(
    agentId: string,
    userId: string,
  ): Promise<AgentSkillAssignment[]>;
  selectSkillsByAgentId(agentId: string, userId: string): Promise<Skill[]>;
  selectSkillSummariesByAgentId(
    agentId: string,
    userId: string,
    limit: number,
  ): Promise<Array<{ id: string; name: string; description: string }>>;
  selectSkillContentById(
    id: string,
    userId: string,
  ): Promise<{ body: string; resources: string[] } | null>;
  selectSkillFileByPath(
    id: string,
    path: string,
    userId: string,
  ): Promise<{ path: string; content: string } | null>;
  selectSkillFiles(id: string, userId: string): Promise<SkillFile[] | null>;
  upsertSkillFile(
    id: string,
    userId: string,
    file: SkillFile,
  ): Promise<SkillFile>;
  deleteSkillFile(id: string, userId: string, path: string): Promise<boolean>;
  checkAccess(skillId: string, userId: string): Promise<boolean>;
};
