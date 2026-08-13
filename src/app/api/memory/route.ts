import { getSession } from "auth/server";
import { memoryRepository } from "lib/db/repository";
import { UserMemoryInputSchema } from "app-types/memory";
import {
  isSafeMemoryContent,
  sanitizeMemoryContent,
} from "lib/ai/memory/guardrails";
import { z } from "zod";

export async function GET() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await memoryRepository.list(session.user.id));
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const input = UserMemoryInputSchema.parse(await request.json());
    const content = sanitizeMemoryContent(input.content);
    if (!isSafeMemoryContent(content))
      return Response.json(
        { error: "Sensitive or unsafe content cannot be stored automatically" },
        { status: 422 },
      );
    const memory = await memoryRepository.create({
      ...input,
      content,
      userId: session.user.id,
      provenance: "manual",
    });
    return Response.json(memory, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid request" },
      { status: 400 },
    );
  }
}

export async function DELETE() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  await memoryRepository.clear(session.user.id);
  return new Response(null, { status: 204 });
}
