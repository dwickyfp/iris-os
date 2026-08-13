"use client";

import { ShareableCard } from "@/components/shareable-card";
import type { Visibility } from "@/components/shareable-actions";
import { useBookmark } from "@/hooks/queries/use-bookmark";
import { useMutateSkills } from "@/hooks/queries/use-skills";
import { useSkills } from "@/hooks/queries/use-skills";
import type { SkillSummary } from "app-types/skill";
import { SkillUpdateSchema } from "app-types/skill";
import { canCreateSkill } from "lib/auth/client-permissions";
import { notify } from "lib/notify";
import { fetcher } from "lib/utils";
import { ArrowUpRight, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { BackgroundPaths } from "ui/background-paths";
import { Button } from "ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "ui/card";
import { handleErrorWithToast } from "ui/shared-toast";

interface SkillsListProps {
  initialMySkills: SkillSummary[];
  initialSharedSkills: SkillSummary[];
  userId: string;
  userRole?: string | null;
}

export function SkillsList({
  initialMySkills,
  initialSharedSkills,
  userId,
  userRole,
}: SkillsListProps) {
  const [skills, setSkills] = useState([
    ...initialMySkills,
    ...initialSharedSkills,
  ]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mutateSkills = useMutateSkills();
  const { skills: archivedSkills, mutate: mutateArchived } = useSkills({
    filters: ["mine"],
    archived: true,
  });
  const { toggleBookmark, isLoading: isBookmarkLoading } = useBookmark({
    itemType: "skill",
  });
  const canCreate = canCreateSkill(userRole);
  const mySkills = skills.filter((skill) => skill.userId === userId);
  const sharedSkills = skills.filter((skill) => skill.userId !== userId);

  const updateVisibility = async (id: string, visibility: Visibility) => {
    if (visibility === "public") return;
    setBusyId(id);
    try {
      const body = JSON.stringify(SkillUpdateSchema.parse({ visibility }));
      await fetcher(`/api/skill/${id}`, { method: "PUT", body });
      setSkills((current) =>
        current.map((skill) =>
          skill.id === id ? { ...skill, visibility } : skill,
        ),
      );
      mutateSkills({ id, visibility });
      toast.success("Skill visibility updated");
    } catch (error) {
      handleErrorWithToast(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setBusyId(null);
    }
  };

  const deleteSkill = async (id: string) => {
    const confirmed = await notify.confirm({
      description: "Archive this skill? It can be restored later.",
    });
    if (!confirmed) return;
    setBusyId(id);
    try {
      await fetcher(`/api/skill/${id}`, { method: "DELETE" });
      setSkills((current) => current.filter((skill) => skill.id !== id));
      mutateSkills({ id }, true);
      await mutateArchived();
      toast.success("Skill archived");
    } catch (error) {
      handleErrorWithToast(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleBookmark = async (id: string, isBookmarked: boolean) => {
    await toggleBookmark({ id, isBookmarked });
    setSkills((current) =>
      current.map((skill) =>
        skill.id === id ? { ...skill, isBookmarked: !isBookmarked } : skill,
      ),
    );
  };

  const restoreSkill = async (id: string) => {
    setBusyId(id);
    try {
      const restored = await fetcher(`/api/skill/${id}/restore`, {
        method: "POST",
      });
      setSkills((current) => [restored, ...current]);
      mutateSkills(restored);
      await mutateArchived();
      toast.success("Skill restored");
    } catch (error) {
      handleErrorWithToast(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="w-full p-5 sm:p-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Skills</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reusable instruction sets and supporting files for agents.
          </p>
        </div>
        {canCreate && (
          <Button asChild variant="ghost">
            <Link href="/skill/new">
              <Plus className="size-4" /> New skill
            </Link>
          </Button>
        )}
      </div>

      {canCreate && (
        <SkillSection title="My skills">
          <Link href="/skill/new">
            <Card className="relative h-[196px] cursor-pointer overflow-hidden bg-secondary transition-colors hover:bg-input">
              <div className="absolute inset-0 opacity-50">
                <BackgroundPaths />
              </div>
              <CardHeader className="relative h-full">
                <CardTitle>New skill</CardTitle>
                <CardDescription>
                  Create focused instructions with optional supporting files.
                </CardDescription>
                <Button variant="ghost" className="mt-auto ml-auto">
                  Create <ArrowUpRight className="size-3.5" />
                </Button>
              </CardHeader>
            </Card>
          </Link>
          {mySkills.map((skill) => (
            <ShareableCard
              key={skill.id}
              type="skill"
              item={skill}
              href={`/skill/${skill.id}`}
              onVisibilityChange={updateVisibility}
              onDelete={deleteSkill}
              isVisibilityChangeLoading={busyId === skill.id}
              isDeleteLoading={busyId === skill.id}
            />
          ))}
        </SkillSection>
      )}

      <SkillSection title={canCreate ? "Shared skills" : "Available skills"}>
        {sharedSkills.map((skill) => (
          <ShareableCard
            key={skill.id}
            type="skill"
            item={skill}
            isOwner={false}
            href={`/skill/${skill.id}`}
            onBookmarkToggle={handleBookmark}
            isBookmarkToggleLoading={isBookmarkLoading(skill.id)}
          />
        ))}
        {sharedSkills.length === 0 && (
          <Card className="col-span-full border-none bg-transparent">
            <CardHeader className="py-12 text-center">
              <CardTitle>No shared skills</CardTitle>
              <CardDescription>
                Read-only skills shared by other users appear here.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </SkillSection>

      {canCreate && archivedSkills.length > 0 && (
        <SkillSection title="Archived skills">
          {archivedSkills.map((skill) => (
            <Card key={skill.id} className="flex min-h-[150px] flex-col">
              <CardHeader>
                <CardTitle className="truncate text-base">
                  {skill.name}
                </CardTitle>
                <CardDescription className="line-clamp-2">
                  {skill.description}
                </CardDescription>
                <Button
                  variant="outline"
                  className="mt-auto ml-auto"
                  disabled={busyId === skill.id}
                  onClick={() => restoreSkill(skill.id)}
                >
                  Restore
                </Button>
              </CardHeader>
            </Card>
          ))}
        </SkillSection>
      )}
    </div>
  );
}

function SkillSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10 grid gap-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}
