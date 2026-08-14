import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  LearningCandidateTable,
  SkillRevisionTable,
  SkillTable,
} from "lib/db/pg/schema.pg";
import type { SkillManifestEntry } from "./types";
import { rankScopedLearnedSkills } from "./scoped-ranking";

export async function selectScopedLearnedSkillSummaries(input: {
  userId: string;
  query: string;
  workspaceId?: string;
  taskId?: string;
  agentId?: string;
}): Promise<SkillManifestEntry[]> {
  const rows = await pgDb
    .selectDistinct({
      id: SkillTable.id,
      name: SkillTable.name,
      description: SkillTable.description,
      scopeType: LearningCandidateTable.scopeType,
      scopeId: LearningCandidateTable.scopeId,
    })
    .from(SkillTable)
    .innerJoin(
      LearningCandidateTable,
      eq(SkillTable.sourceCandidateId, LearningCandidateTable.id),
    )
    .innerJoin(
      SkillRevisionTable,
      eq(SkillRevisionTable.skillId, SkillTable.id),
    )
    .where(
      and(
        eq(SkillTable.userId, input.userId),
        eq(SkillTable.provenance, "learned"),
        isNull(SkillTable.archivedAt),
        eq(LearningCandidateTable.status, "confirmed"),
        eq(SkillRevisionTable.status, "approved"),
      ),
    )
    .limit(100);

  return rankScopedLearnedSkills(rows, input);
}
