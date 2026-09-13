# Repository Memory

Last updated: 2026-08-14

## Repository purpose

IRIS-OS is a Next.js application for multi-provider AI chat, agents, MCP tools,
skills, visual workflows, voice, file storage, and persistent user memory.

## Current architecture

- Next.js route handlers and server actions call PostgreSQL repositories built
  with Drizzle.
- `POST /api/chat` currently composes chat, agent, tools, workflows, skills,
  memory recall, streaming, persistence, and memory-review enqueueing. Skills
  support `private`/`readonly`/`public` visibility (public is read/assign for
  all, edit owner-only, migration 0074), and plain chats without an agent get
  the user's own non-archived skills (max 20) through the same manifest
  runtime; agent chats remain assignment-only.
- Memory V2 scopes claims, topics, entities, edges, evidence, embeddings, and
  audits exactly across global/workspace/task/agent contexts.
- Workspace, task ledger, activity/learning, learned-skill, workflow automation,
  delegation records, and OS dashboard foundations are implemented behind V2
  feature flags on `codex/iris-v2-foundation`.
- Agent execution uses Vercel AI SDK `ToolLoopAgent`; workflows and Skills have
  existing runtimes that V2 must extend rather than replace.
- `IrisHarness` owns foreground/headless execution lifecycle. Stream consumers
  use `{ native, finalize, fail }`; `generate()` verifies and finalizes while
  returning the exact native generation result for migration compatibility.
- The server-side sandbox subsystem (SandboxManager, Docker/gVisor runner,
  `python_compute`/`sandbox_exec` tools, and workflow compute nodes) was fully
  removed; migration `0063_drop_sandbox_subsystem.sql` drops its tables and
  budget columns only after provider inventory and execution settlement are
  acknowledged as drained. Retired or unknown workflow node kinds fail closed;
  historical `python_compute` results remain read-only. Client-side JS/Python
  execution and the shared
  `ArtifactService` (with worker-driven cleanup reaping) remain.
- Intelligence Harness extends the existing AgentRun checkpoint/resume path:
  migration 0065 persists canonical goal requirements and bounded goal rounds;
  0066 adds root goal revision authority and durable RunInbox attention state.
  Strategy, result-surface, scheduler, context-pressure, composition, jobs,
  projection, telemetry, and evaluation remain domain-neutral primitives and do
  not create a parallel runtime or restore arbitrary code execution.
- Application configuration now lives in Admin > Settings and encrypted
  PostgreSQL tables. Only `POSTGRES_URL`, `IRIS_ROOT_ENCRYPTION_KEY`, process
  platform values, and external tooling inputs remain environment-owned.
  S3-compatible object storage uses immutable database profiles with encrypted
  credentials, profile-aware artifacts/cleanup, owner-scoped uploads, and an
  explicit activation/test workflow. Durable jobs use bounded targets,
  at-most-once orchestration, lease fencing, revision guards, and a completion
  outbox.
- Chat agents (base and custom) can spawn in-process subagents via the
  `spawn_subagent` tool (`src/lib/ai/tools/subagent/`): AI SDK 7 subagents
  pattern with preliminary UIMessage streaming, `toModelOutput` context
  isolation, and a canonical Markdown artifact per run. Gated by the
  `subagents` feature flag (default on, `IRIS_SUBAGENTS_V2=false|0` to
  disable). Clicking the chat card opens a right-side artifact panel driven by
  `appStore.subagentArtifactPanels`.
- Agents have a scoped virtual filesystem via the `workspace_fs` tool
  (`src/lib/ai/tools/workspace-fs/`, service in `src/lib/ai/workspace-fs/`):
  read/write/edit/list/move/delete/search/import_artifact over UTF-8 text
  files stored inline in the `workspace_file` table (migration 0075). The
  tool API is the security boundary — no code execution, no host fs access;
  paths are jailed per (userId, scopeKey) with task > workspace > global
  precedence, bounded by WORKSPACE_FS_LIMITS, and rows carry optimistic
  `version`s. Gated by the `workspaceFs` feature flag (default on,
  `IRIS_WORKSPACE_FS_V2=false|0` to disable); runtime context is read from
  tool execute options context, not closed over. Large/binary content stays
  with the artifact subsystem; `import_artifact` bridges text artifacts in.
- AI SDK v7 resolves tool execute `options.context` as
  `toolsContext[toolName]`. The chat route passes a per-tool
  `toolsContext` map (`spawn_subagent`, `workspace_fs`); tools that read
  `options.context` must be keyed there or they receive `undefined` and must
  fail closed.

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
