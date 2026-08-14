import { getSession } from "auth/server";
import { memoryGraphRepository, memoryRepository } from "lib/db/repository";
import { MemoryScopeTypeSchema, UserMemoryInputSchema } from "app-types/memory";
import { resolveOwnedMemoryScope } from "lib/ai/memory/scope-server";
import {
  isSafeMemoryContent,
  sanitizeMemoryContent,
} from "lib/ai/memory/guardrails";
import { z } from "zod";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const url = new URL(request.url);
    const scope = await resolveOwnedMemoryScope(session.user.id, {
      scopeType: MemoryScopeTypeSchema.parse(
        url.searchParams.get("scopeType") ?? "global",
      ),
      scopeId: url.searchParams.get("scopeId"),
    });
    return Response.json(await memoryRepository.list(session.user.id, scope));
  } catch {
    return Response.json({ error: "Memory scope not found" }, { status: 404 });
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const input = UserMemoryInputSchema.parse(await request.json());
    const scope = await resolveOwnedMemoryScope(session.user.id, input);
    const content = sanitizeMemoryContent(input.content);
    if (!isSafeMemoryContent(content))
      return Response.json(
        { error: "Sensitive or unsafe content cannot be stored automatically" },
        { status: 422 },
      );
    const result = await memoryGraphRepository.curateClaim({
      ...input,
      content,
      userId: session.user.id,
      provenance: "manual",
      scope,
    });
    const memory = (await memoryRepository.list(session.user.id, scope)).find(
      (item) => item.id === result.memoryId,
    );
    return Response.json(memory, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid request" },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const scope = await resolveOwnedMemoryScope(session.user.id, {
    scopeType: MemoryScopeTypeSchema.parse(
      url.searchParams.get("scopeType") ?? "global",
    ),
    scopeId: url.searchParams.get("scopeId"),
  });
  await memoryRepository.clear(session.user.id, scope);
  return new Response(null, { status: 204 });
}
