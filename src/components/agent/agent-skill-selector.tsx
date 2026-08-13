"use client";

import { useSkills } from "@/hooks/queries/use-skills";
import type { AgentSkillAssignment } from "app-types/skill";
import { fetcher } from "lib/utils";
import { BookOpen, ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "ui/button";
import { Checkbox } from "ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "ui/popover";
import { handleErrorWithToast } from "ui/shared-toast";

interface AgentSkillSelectorProps {
  agentId: string;
  disabled?: boolean;
  hasEditAccess?: boolean;
}

export function AgentSkillSelector({
  agentId,
  disabled,
  hasEditAccess = true,
}: AgentSkillSelectorProps) {
  const t = useTranslations("Skill");
  const { skills, isLoading: isLoadingOptions } = useSkills({
    filters: ["mine", "shared"],
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    fetcher(`/api/agent/${agentId}/skills`)
      .then((skills: AgentSkillAssignment[]) => {
        if (active) setSelectedIds(skills.map((skill) => skill.id));
      })
      .catch((error: unknown) =>
        handleErrorWithToast(
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
      .finally(() => active && setIsLoading(false));
    return () => {
      active = false;
    };
  }, [agentId]);

  const toggle = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((skillId) => skillId !== id)
        : [...current, id],
    );
    setIsDirty(true);
  };

  const save = async () => {
    setIsSaving(true);
    try {
      await fetcher(`/api/agent/${agentId}/skills`, {
        method: "PUT",
        body: JSON.stringify({ skillIds: selectedIds }),
      });
      setIsDirty(false);
      toast.success(t("assignmentsUpdated"));
    } catch (error) {
      handleErrorWithToast(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const busy = disabled || isLoading || isLoadingOptions || isSaving;

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("agentSkillsDescription")}
        </p>
        {hasEditAccess && isDirty && (
          <Button size="sm" variant="outline" disabled={busy} onClick={save}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            {t("applyAssignments")}
          </Button>
        )}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            className="h-auto min-h-12 justify-start py-3"
            disabled={busy || !hasEditAccess}
          >
            <BookOpen className="size-4" />
            <span className="mr-auto truncate">
              {isLoading
                ? t("loadingSkills")
                : selectedIds.length === 0
                  ? t("addSkills")
                  : `${selectedIds.length} skill${selectedIds.length === 1 ? "" : "s"} selected`}
            </span>
            <ChevronDown className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] p-2"
        >
          {skills.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {t("createFirst")}
            </p>
          ) : (
            <div className="grid max-h-72 gap-1 overflow-y-auto">
              {skills.map((skill) => (
                <label
                  key={skill.id}
                  className="flex cursor-pointer items-start gap-3 rounded-md p-3 hover:bg-input"
                >
                  <Checkbox
                    checked={selectedIds.includes(skill.id)}
                    onCheckedChange={() => toggle(skill.id)}
                  />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate text-sm font-medium">
                      {skill.name}
                    </span>
                    {skill.description && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
