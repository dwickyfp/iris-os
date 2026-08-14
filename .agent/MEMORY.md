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
- Memory V2 scopes claims, topics, entities, edges, evidence, embeddings, and
  audits exactly across global/workspace/task/agent contexts.
- Workspace, task ledger, activity/learning, learned-skill, workflow automation,
  delegation records, and OS dashboard foundations are implemented behind V2
  feature flags on `codex/iris-v2-foundation`.
- Agent execution uses Vercel AI SDK `ToolLoopAgent`; workflows and Skills have
  existing runtimes that V2 must extend rather than replace.

## Stable constraints

- Preserve legacy global chats and existing memory during V2 migrations.
- Enforce ownership and scope server-side; client request scope is not
  authoritative for an existing thread.
- Use additive migrations and vertical slices; do not create parallel runtimes.
- New behavior follows test-first RED-GREEN-REFACTOR.
- Treat memory meaning as a model-reviewed decision: regex may sanitize input
  but must not classify preference, negation, subject, scope, or conflict.
- Memory review mutations are one atomic, idempotent batch. Any correction must
  preserve evidence and lineage through a superseded node and `SUPERSEDES` edge.
- Internal LLM consumers resolve through typed global system-engine assignments;
  foreground chat and workflow-node model selection remain independent.

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

- Chat streaming is a high-coupling integration point, so domain extraction must
  preserve current persistence, approval, and streaming behavior.
- Skill/agent automation execution and queued delegated-child execution still
  require adapters to the existing runtimes; unsupported automation targets
  currently fail explicitly instead of reporting false success.
- Repository defaults keep agentic memory curation in shadow mode. The local
  development environment may explicitly enable write mode after verification.

## Active work

See `.agent/workstreams/active/`.

## Accepted decisions

See `.agent/DECISIONS.md`.

## Known traps

See `.agent/KNOWN-TRAPS.md`.

## Pending learning candidates

See `.agent/LEARNINGS.md` and `.agent/skill-candidates/`.
