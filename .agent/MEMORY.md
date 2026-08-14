# Repository Memory

Last updated: 2026-08-14

## Repository purpose

IRIS-OS is a Next.js application for multi-provider AI chat, agents, MCP tools,
skills, visual workflows, voice, file storage, and persistent user memory.

## Current architecture

- Next.js route handlers and server actions call PostgreSQL repositories built
  with Drizzle.
- `POST /api/chat` currently composes chat, agent, tools, workflows, skills,
  memory recall, streaming, persistence, and memory-review enqueueing.
- Memory uses claims, topics, entities, edges, evidence, optional embeddings,
  retrieval audits, and a PgBoss background worker.
- Agent execution uses Vercel AI SDK `ToolLoopAgent`; workflows and Skills have
  existing runtimes that V2 must extend rather than replace.

## Stable constraints

- Preserve legacy global chats and existing memory during V2 migrations.
- Enforce ownership and scope server-side; client request scope is not
  authoritative for an existing thread.
- Use additive migrations and vertical slices; do not create parallel runtimes.
- New behavior follows test-first RED-GREEN-REFACTOR.

## Important entry points

- `src/app/api/chat/route.ts`
- `src/lib/db/pg/schema.pg.ts`
- `src/lib/db/repository.ts`
- `src/lib/ai/memory/`
- `src/lib/ai/agent/runtime-context.ts`

## Validation commands

- `pnpm lint`
- `pnpm check-types`
- `pnpm test`

## Known risks

- Memory graph storage and queries are currently user-scoped only; adding scope
  to claims alone would still allow cross-workspace topic/entity/edge leakage.
- Chat streaming is a high-coupling integration point, so domain extraction must
  preserve current persistence, approval, and streaming behavior.

## Active work

See `.agent/workstreams/active/`.

## Accepted decisions

See `.agent/DECISIONS.md`.

## Known traps

See `.agent/KNOWN-TRAPS.md`.

## Pending learning candidates

See `.agent/LEARNINGS.md` and `.agent/skill-candidates/`.
