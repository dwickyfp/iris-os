import { SkillsList } from "@/components/skill/skills-list";
import { getSession } from "auth/server";
import { skillRepository } from "lib/db/repository";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const session = await getSession();
  if (!session?.user.id) notFound();
  const skills = await skillRepository.selectSkills(
    session.user.id,
    ["mine", "shared"],
    50,
  );

  return (
    <SkillsList
      initialMySkills={skills.filter(
        (skill) => skill.userId === session.user.id,
      )}
      initialSharedSkills={skills.filter(
        (skill) => skill.userId !== session.user.id,
      )}
      userId={session.user.id}
      userRole={session.user.role}
    />
  );
}
