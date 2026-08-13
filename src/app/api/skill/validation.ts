import {
  MAX_SKILL_ASSIGNMENTS,
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_TOTAL_FILE_SIZE,
  SkillCreateSchema,
  SkillFilePathSchema,
  SkillFileSchema,
  SkillQuerySchema,
  SkillUpdateSchema,
} from "app-types/skill";
import { z } from "zod";

const limitedFiles = z
  .array(SkillFileSchema)
  .max(MAX_SKILL_FILES)
  .superRefine((files, context) => {
    const paths = new Set<string>();
    let totalBytes = 0;

    for (const [index, file] of files.entries()) {
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          message: "Skill file paths must be unique",
          path: [index, "path"],
        });
      }
      paths.add(file.path);
      totalBytes += file.size ?? 0;
    }

    if (totalBytes > MAX_SKILL_TOTAL_FILE_SIZE) {
      context.addIssue({
        code: "custom",
        message: `Skill files must not exceed ${MAX_SKILL_TOTAL_FILE_SIZE} bytes in total`,
      });
    }
  });

export const SkillCollectionQuerySchema = SkillQuerySchema.extend({
  archived: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
});

export const SkillRouteCreateSchema = SkillCreateSchema.omit({
  userId: true,
}).extend({ files: limitedFiles.default([]) });

export const SkillRouteUpdateSchema = SkillUpdateSchema.extend({
  files: limitedFiles.optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one field is required",
});

export const SkillFileUpsertSchema = SkillFileSchema.omit({
  path: true,
}).strict();

export const AgentSkillsUpdateSchema = z
  .object({
    skillIds: z.array(z.string().uuid()).max(MAX_SKILL_ASSIGNMENTS),
  })
  .strict()
  .superRefine(({ skillIds }, context) => {
    if (new Set(skillIds).size !== skillIds.length) {
      context.addIssue({
        code: "custom",
        message: "Skill IDs must be unique",
        path: ["skillIds"],
      });
    }
  });

export function parseSkillFilePath(segments: string[]): string {
  let path: string;
  try {
    path = segments.map(decodeURIComponent).join("/");
  } catch {
    throw new z.ZodError([
      { code: "custom", message: "Invalid encoded file path", path: [] },
    ]);
  }
  return SkillFilePathSchema.parse(path);
}

export function isRepositoryConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  return (
    candidate.code === "23505" ||
    candidate.name === "ConflictError" ||
    (typeof candidate.message === "string" &&
      /already|assigned|unavailable|at most|shared agents|must be unique/i.test(
        candidate.message,
      ))
  );
}

export { MAX_SKILL_ASSIGNMENTS, MAX_SKILL_FILE_SIZE };

export function invalidResponse(error: z.ZodError): Response {
  return Response.json(
    { error: "Invalid input", details: z.treeifyError(error) },
    { status: 400 },
  );
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new z.ZodError([
      { code: "custom", message: "Request body must be valid JSON", path: [] },
    ]);
  }
}
