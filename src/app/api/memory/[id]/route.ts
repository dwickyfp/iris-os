import { getSession } from "auth/server";
import { memoryRepository } from "lib/db/repository";
import { UserMemoryInputSchema } from "app-types/memory";
import {
  isSafeMemoryContent,
  sanitizeMemoryContent,
} from "lib/ai/memory/guardrails";
import { z } from "zod";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const input = UserMemoryInputSchema.partial().parse(await request.json());
    if (
      input.content &&
      !isSafeMemoryContent(sanitizeMemoryContent(input.content))
    )
      return Response.json({ error: "Unsafe memory content" }, { status: 422 });
    const memory = await memoryRepository.update(
      (await params).id,
      session.user.id,
      {
        ...input,
        ...(input.content
          ? { content: sanitizeMemoryContent(input.content) }
          : {}),
      },
    );
    return Response.json(memory);
  } catch (error) {
    return Response.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid request" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  await memoryRepository.remove((await params).id, session.user.id);
  return new Response(null, { status: 204 });
}
