"use client";

import type { Skill } from "app-types/skill";
import { fetcher } from "lib/utils";
import useSWR, { type SWRConfiguration } from "swr";
import { handleErrorWithToast } from "ui/shared-toast";

interface UseSkillOptions extends SWRConfiguration<Skill> {
  enabled?: boolean;
}

export function useSkill(
  skillId: string | null | undefined,
  options: UseSkillOptions = {},
) {
  const { enabled = true, ...swrOptions } = options;
  const { data, error, isLoading, mutate } = useSWR<Skill>(
    skillId && enabled ? `/api/skill/${skillId}` : null,
    fetcher,
    {
      errorRetryCount: 0,
      revalidateOnFocus: false,
      onError: handleErrorWithToast,
      ...swrOptions,
    },
  );

  return { skill: data, error, isLoading, mutate };
}
