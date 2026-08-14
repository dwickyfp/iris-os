import type { SkillManifestEntry } from "./types";

const MAX_SCOPED_LEARNED_SKILLS = 8;

type ScopedSkillRow = SkillManifestEntry & {
  scopeType: "global" | "workspace" | "task" | "agent";
  scopeId: string | null;
};

function terms(value: string) {
  return new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 3),
  );
}

function scopeRank(
  scopeType: "global" | "workspace" | "task" | "agent",
) {
  return scopeType === "task"
    ? 4
    : scopeType === "agent"
      ? 3
      : scopeType === "workspace"
        ? 2
        : 1;
}

export function rankScopedLearnedSkills(
  rows: ScopedSkillRow[],
  input: {
    query: string;
    workspaceId?: string;
    taskId?: string;
    agentId?: string;
  },
) {
  const queryTerms = terms(input.query);
  return rows
    .filter((row) => {
      if (row.scopeType === "global") return row.scopeId === null;
      if (row.scopeType === "workspace")
        return row.scopeId === input.workspaceId;
      if (row.scopeType === "task") return row.scopeId === input.taskId;
      return row.scopeId === input.agentId;
    })
    .map((row) => {
      const skillTerms = terms(`${row.name} ${row.description}`);
      const overlap = [...queryTerms].filter((term) =>
        skillTerms.has(term),
      ).length;
      return { ...row, score: scopeRank(row.scopeType) * 10 + overlap };
    })
    .filter((row) => row.score % 10 > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_SCOPED_LEARNED_SKILLS)
    .map(({ id, name, description }) => ({ id, name, description }));
}
