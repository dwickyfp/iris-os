import { requireAdminActor } from "auth/permissions";
import { pgStorageProfileRepository } from "lib/db/pg/repositories/storage-profile-repository.pg";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let actor: { id: string };
  try {
    actor = await requireAdminActor();
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    adoptLegacyObjects?: boolean;
  };
  if (!(await pgStorageProfileRepository.getById(id)))
    return Response.json({ error: "Profile not found" }, { status: 404, headers: NO_STORE });
  await pgStorageProfileRepository.activate(id, actor.id, {
    adoptLegacyObjects: body.adoptLegacyObjects === true,
  });
  return Response.json({ ok: true }, { headers: NO_STORE });
}
