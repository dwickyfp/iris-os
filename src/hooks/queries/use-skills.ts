"use client";

import { authClient } from "auth/client";
import type { SkillSummary } from "app-types/skill";
import { fetcher } from "lib/utils";
import useSWR, { type SWRConfiguration, useSWRConfig } from "swr";
import { handleErrorWithToast } from "ui/shared-toast";

interface UseSkillsOptions extends SWRConfiguration<SkillSummary[]> {
  filters?: ("all" | "mine" | "shared" | "bookmarked")[];
  limit?: number;
  archived?: boolean;
}

export function useSkills(options: UseSkillsOptions = {}) {
  const {
    filters = ["all"],
    limit = 50,
    archived = false,
    ...swrOptions
  } = options;
  const query = new URLSearchParams({
    filters: filters.join(","),
    limit: limit.toString(),
    archived: archived.toString(),
  });
  const {
    data: skills = [],
    error,
    isLoading,
    mutate,
  } = useSWR<SkillSummary[]>(`/api/skill?${query.toString()}`, fetcher, {
    errorRetryCount: 0,
    revalidateOnFocus: false,
    fallbackData: [],
    onError: handleErrorWithToast,
    ...swrOptions,
  });
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;

  return {
    skills,
    mySkills: skills.filter((skill) => skill.userId === userId),
    sharedSkills: skills.filter((skill) => skill.userId !== userId),
    bookmarkedSkills: skills.filter(
      (skill) => skill.userId !== userId && skill.isBookmarked,
    ),
    isLoading,
    error,
    mutate,
  };
}

export function useMutateSkills() {
  const { mutate } = useSWRConfig();

  return (
    updatedSkill?: Partial<SkillSummary> & { id: string },
    deleteSkill = false,
  ) => {
    mutate(
      (key) =>
        typeof key === "string" &&
        key.startsWith("/api/skill") &&
        !key.match(/\/api\/skill\/[^/?]+/),
      (cached: unknown) => {
        if (!Array.isArray(cached) || !updatedSkill) return cached;
        if (deleteSkill) {
          return cached.filter((skill) => skill.id !== updatedSkill.id);
        }
        const index = cached.findIndex((skill) => skill.id === updatedSkill.id);
        if (index === -1) return [updatedSkill, ...cached];
        const next = [...cached];
        next[index] = { ...next[index], ...updatedSkill };
        return next;
      },
      { revalidate: true },
    );

    if (updatedSkill) {
      mutate(
        `/api/skill/${updatedSkill.id}`,
        deleteSkill
          ? undefined
          : (cached: unknown) =>
              cached && typeof cached === "object"
                ? { ...cached, ...updatedSkill }
                : cached,
        { revalidate: true },
      );
    }
  };
}
