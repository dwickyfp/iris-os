"use client";

import { ShareableActions } from "@/components/shareable-actions";
import { useBookmark } from "@/hooks/queries/use-bookmark";
import { useMutateSkills } from "@/hooks/queries/use-skills";
import type { Skill, SkillVisibility } from "app-types/skill";
import { SkillCreateSchema, SkillUpdateSchema } from "app-types/skill";
import { notify } from "lib/notify";
import { fetcher } from "lib/utils";
import { Loader2, WandSparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "ui/button";
import { ScrollArea } from "ui/scroll-area";
import { handleErrorWithToast } from "ui/shared-toast";
import { GenerateSkillDialog } from "./generate-skill-dialog";
import { SkillBodyEditor } from "./skill-body-editor";
import { SkillFileManager } from "./skill-file-manager";
import { SkillMetadataEditor } from "./skill-metadata-editor";

interface EditSkillProps {
  initialSkill?: Skill;
  userId: string;
  isOwner?: boolean;
  hasEditAccess?: boolean;
}

export default function EditSkill({
  initialSkill,
  userId,
  isOwner = true,
  hasEditAccess = true,
}: EditSkillProps) {
  const router = useRouter();
  const mutateSkills = useMutateSkills();
  const [skill, setSkill] = useState<
    Pick<
      Skill,
      | "name"
      | "description"
      | "license"
      | "compatibility"
      | "metadata"
      | "allowedTools"
      | "body"
      | "visibility"
      | "files"
    >
  >({
    name: initialSkill?.name ?? "",
    description: initialSkill?.description ?? "",
    license: initialSkill?.license,
    compatibility: initialSkill?.compatibility,
    metadata: initialSkill?.metadata,
    allowedTools: initialSkill?.allowedTools,
    body: initialSkill?.body ?? "",
    visibility: initialSkill?.visibility ?? "private",
    files: initialSkill?.files ?? [],
  });
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerateDialogOpen, setIsGenerateDialogOpen] = useState(false);
  const { toggleBookmark, isLoading: bookmarkLoading } = useBookmark({
    itemType: "skill",
  });
  const isBookmarkLoading = initialSkill
    ? bookmarkLoading(initialSkill.id)
    : false;

  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

  const update = (values: Partial<typeof skill>) => {
    setSkill((current) => ({ ...current, ...values }));
    setIsDirty(true);
  };

  const applyGeneratedSkill = useCallback(
    (values: Partial<typeof skill>) => update(values),
    [],
  );

  const save = async () => {
    setIsSaving(true);
    try {
      const body = initialSkill
        ? SkillUpdateSchema.parse(skill)
        : SkillCreateSchema.parse({ ...skill, userId });
      const saved = await fetcher(
        initialSkill ? `/api/skill/${initialSkill.id}` : "/api/skill",
        { method: initialSkill ? "PUT" : "POST", body: JSON.stringify(body) },
      );
      setIsDirty(false);
      mutateSkills(saved);
      toast.success(initialSkill ? "Skill updated" : "Skill created");
      router.push("/skills");
    } catch (error) {
      handleErrorWithToast(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const updateVisibility = async (visibility: SkillVisibility) => {
    if (!initialSkill) {
      update({ visibility });
      return;
    }
    setIsSaving(true);
    try {
      await fetcher(`/api/skill/${initialSkill.id}`, {
        method: "PUT",
        body: JSON.stringify(SkillUpdateSchema.parse({ visibility })),
      });
      // Keep all unsaved editor fields intact when visibility saves separately.
      setSkill((current) => ({ ...current, visibility }));
      mutateSkills({ id: initialSkill.id, visibility });
      toast.success("Skill visibility updated");
    } catch (error) {
      handleErrorWithToast(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const deleteSkill = async () => {
    if (!initialSkill) return;
    const confirmed = await notify.confirm({
      description:
        "Archive this skill? It can be restored from the skills page.",
    });
    if (!confirmed) return;
    setIsSaving(true);
    try {
      await fetcher(`/api/skill/${initialSkill.id}`, { method: "DELETE" });
      mutateSkills({ id: initialSkill.id }, true);
      setIsDirty(false);
      router.push("/skills");
    } catch (error) {
      handleErrorWithToast(
        error instanceof Error ? error : new Error(String(error)),
      );
      setIsSaving(false);
    }
  };

  const bookmark = async (wasBookmarked: boolean) => {
    if (!initialSkill) return;
    await toggleBookmark({ id: initialSkill.id, isBookmarked: wasBookmarked });
    mutateSkills({ id: initialSkill.id, isBookmarked: !wasBookmarked });
  };

  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto grid max-w-4xl gap-8 px-5 py-8 pb-16 sm:px-8">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-background pb-4">
          <div>
            <h1 className="text-2xl font-bold">
              {initialSkill ? "Skill" : "New skill"}
            </h1>
            {isDirty && (
              <p className="text-xs text-muted-foreground">Unsaved changes</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasEditAccess && !initialSkill && (
              <Button
                variant="ghost"
                disabled={isSaving}
                onClick={() => setIsGenerateDialogOpen(true)}
                data-testid="skill-generate-with-ai-button"
              >
                <WandSparkles className="size-3" />
                Generate with AI
              </Button>
            )}
            {initialSkill && (
              <ShareableActions
                type="skill"
                visibility={skill.visibility}
                isOwner={isOwner}
                isBookmarked={initialSkill.isBookmarked}
                onVisibilityChange={(value) =>
                  value !== "public" && updateVisibility(value)
                }
                onBookmarkToggle={bookmark}
                isVisibilityChangeLoading={isSaving}
                isBookmarkToggleLoading={isBookmarkLoading}
                disabled={isSaving}
              />
            )}
          </div>
        </header>

        <SkillMetadataEditor
          name={skill.name}
          description={skill.description ?? ""}
          license={skill.license}
          compatibility={skill.compatibility}
          metadata={skill.metadata}
          allowedTools={skill.allowedTools}
          disabled={!hasEditAccess || isSaving}
          onChange={update}
        />
        <SkillBodyEditor
          body={skill.body}
          disabled={!hasEditAccess || isSaving}
          onChange={(body) => update({ body })}
        />
        <SkillFileManager
          files={skill.files}
          disabled={!hasEditAccess || isSaving}
          onChange={(files) => update({ files })}
        />

        {hasEditAccess && (
          <div className="flex justify-end gap-2">
            {initialSkill && isOwner && (
              <Button
                variant="ghost"
                className="mr-auto hover:text-destructive"
                disabled={isSaving}
                onClick={deleteSkill}
              >
                Archive
              </Button>
            )}
            <Button disabled={isSaving || !skill.name.trim()} onClick={save}>
              {isSaving ? "Saving" : "Save"}
              {isSaving && <Loader2 className="size-4 animate-spin" />}
            </Button>
          </div>
        )}
      </div>
      <GenerateSkillDialog
        open={isGenerateDialogOpen}
        onOpenChange={setIsGenerateDialogOpen}
        onSkillChange={applyGeneratedSkill}
      />
    </ScrollArea>
  );
}
