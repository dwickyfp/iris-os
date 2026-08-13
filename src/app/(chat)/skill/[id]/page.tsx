import EditSkill from "@/components/skill/edit-skill";
import { getSession } from "auth/server";
import { skillRepository } from "lib/db/repository";
import { notFound, redirect } from "next/navigation";

export default async function SkillPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session?.user.id) redirect("/sign-in");
  const { id } = await params;
  if (id === "new") return <EditSkill userId={session.user.id} />;

  const skill = await skillRepository.selectSkillById(id, session.user.id);
  if (!skill) notFound();
  const isOwner = skill.userId === session.user.id;

  return (
    <EditSkill
      key={id}
      initialSkill={skill}
      userId={session.user.id}
      isOwner={isOwner}
      hasEditAccess={isOwner}
    />
  );
}
