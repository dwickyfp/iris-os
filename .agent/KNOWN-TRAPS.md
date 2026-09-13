# Known Traps

Record verified repository-specific failure patterns that future sessions could repeat.
Include symptoms, cause, safe response, and verification evidence.

## `pnpm check` rewrites files

- **Symptom:** Running the nominal aggregate check can modify source files.
- **Cause:** `package.json` defines `check` with `pnpm lint:fix`.
- **Safe response:** For read-only verification run `pnpm lint`,
  `pnpm check-types`, and `pnpm test` separately.
- **Evidence:** Verified from the current `package.json` on 2026-08-14.

## Polymorphic scope data does not cascade

- **Symptom:** Deleting a workspace or task can leave memory, learning, event,
  and audit rows containing the deleted UUID.
- **Cause:** `scope_id` represents several domain types and cannot use one
  PostgreSQL foreign key.
- **Safe response:** Resolve ownership first, then explicitly delete every
  exact workspace scope and each task scope before deleting the owner row.
- **Evidence:** The V2 review found orphaned task-scope records in the initial
  purge implementation; the corrected route enumerates all scoped tables.

## Scoped upserts must match scoped unique indexes

- **Symptom:** PostgreSQL reports no matching unique constraint while a broad
  fallback silently degrades the feature.
- **Cause:** An `ON CONFLICT` target retained the legacy unscoped columns after
  the migration replaced its unique index.
- **Safe response:** Update every upsert target alongside a scope migration and
  verify both global `NULL` scope and non-global scope behavior.
- **Evidence:** The V2 review caught the memory embedding worker using the old
  `(user_id, node_id, model)` target after migration 0022.
## Server-only modules must not leak through shared barrels

Database-backed server modules such as scoped learned-skill retrieval must be
imported directly by server entrypoints. Re-exporting one from a shared Skill or
agent barrel causes otherwise pure approval/runtime tests and client tooling to
load the `server-only` poison package.

## Background learning requires two deployment processes

The web process only durably writes jobs. `memory-worker` performs agentic
memory review and legacy queue draining, while `iris-worker` processes
activity, safe skill promotion, automation, and delegation according to feature
flags. Enabling a feature without its worker leaves durable work pending by
design.

## Memory run completion must share the mutation transaction

- **Symptom:** A worker crash can retry an already-written proposal and create
  duplicate evidence or competing replacement claims.
- **Cause:** Memory writes and the idempotency run status were committed in
  separate transactions.
- **Safe response:** Serialize by user, validate every operation, commit the
  entire batch, and mark the curator run complete in the same transaction.
- **Evidence:** Agentic curator integration tests cover repeated run keys,
  duplicate evidence, invalid-batch rollback, and supersede lineage.

## System engine assignments require their additive migration

- **Symptom:** Model Settings or background LLM resolution fails because the
  `model_engine_assignment` relation does not exist.
- **Cause:** Application code containing System Engines was deployed before
  migration `0036_system_model_engines`.
- **Safe response:** Apply migrations before starting web and worker processes;
  keep assignment resolution fallback limited to enabled compatible models.
- **Evidence:** Migration, backfill, production build, and admin Playwright
  checks passed on 2026-08-14.

## Biome formatter breaks multi-line `typeof import(...)` type calls

Biome's formatter (default `trailingCommas: all`) rewrites a multi-line
`type X = typeof import("mod")["member"];` into a trailing comma inside the
type-level import call — `typeof import("mod",)["member"]`. esbuild (vitest)
and `tsc` reject that syntax (TS1005), so a repo-wide `biome check --write` /
`pnpm format` silently breaks any file using this pattern
(e.g. `tests/integration/db/memory-recall.test.ts`). Do not run repo-wide
biome writes; if forced, re-check `typeof import(` occurrences afterwards.

## Docker Hub pulls fail on this machine; use quay.io mirrors

- **Symptom:** `docker pull minio/minio:...` (and other Docker Hub images) fails
  with `pull access denied ... requested access to the resource is denied`
  even though the host can reach `registry-1.docker.io` and `auth.docker.io`.
- **Cause:** The local Docker daemon cannot authenticate against Docker Hub
  (proxy-related); quay.io is reachable.
- **Safe response:** Pull the same tag from `quay.io/<namespace>/<image>` and
  `docker tag` it to the Docker Hub name so `docker/compose.yml` keeps working,
  as done for `minio/minio` and `minio/mc` on 2026-09-12.
- **Evidence:** `quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z` and
  `quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z` pulled successfully;
  `docker-minio-1` healthy on ports 9000/9001.

## Bare `text @@ tsquery` bypasses expression GIN indexes

- **Symptom:** Memory recall and chat-history search run a sequential scan
  despite `user_memory_content_fts_idx` (0072) or
  `chat_message_search_content_fts_idx` (0073) existing.
- **Cause:** `content @@ to_tsquery(...)` on a raw `text` column never matches
  an expression index built on `to_tsvector('simple', content)`; the indexed
  expression must appear verbatim on the tsvector side of the predicate.
- **Safe response:** Write `to_tsvector('simple', content) @@ to_tsquery(...)`
  (or `websearch_to_tsquery`) in every FTS predicate and ranking expression.
  Verify with `EXPLAIN` showing a Bitmap Index Scan, not a Seq Scan.
- **Evidence:** `scripts/memory-benchmark.ts` measured 220 ms (seq scan) vs
  5 ms (bitmap scan) over 100k rows on 2026-09-12 after fixing
  `lib/ai/memory/lexical-search.ts` and `lib/ai/memory/service.ts`.

## E2E sign-in throttling on a reused dev server

- **Symptom:** Playwright `auth-states.setup.ts` fails on the fourth
  sequential UI sign-in (admin, editor, editor2 pass; regular user times out
  with no error shown).
- **Cause:** `E2E_DISABLE_AUTH_RATE_LIMIT=1` is set in `playwright.config.ts`
  so it only reaches a Playwright-spawned webServer. With
  `reuseExistingServer`, the user's dev server keeps Better Auth rate limiting
  enabled and throttles the fourth rapid sign-in.
- **Safe response:** `signInViaUi` now waits out the rate-limit window and
  retries once. Do not "fix" this by restarting the user's dev server.
- **Evidence:** Verified 2026-09-12: curl `POST /api/auth/sign-in/email` for
  the same account returned 200, and a standalone Playwright script succeeded;
  only the sequential setup run failed. All 4 auth states pass with the retry.

## Drizzle generate must not be run on this repository's migrations

- **Symptom:** `pnpm db:generate` emits a migration that re-applies already
  shipped changes (for example re-running `DROP TABLE memory_embedding`).
- **Cause:** Migrations 0071-0073 were hand-written without Drizzle snapshots,
  so the generator diffs from an outdated 0069-era snapshot.
- **Safe response:** Write new migrations by hand, append the journal entry
  manually, and never overwrite `_journal.json` with `git checkout` without
  checking for uncommitted entries first (the 0073 entry was working-tree only
  and was restored by hand).
- **Evidence:** Verified 2026-09-12 when adding `0074_skill_public_visibility`.

## Biome format breaks `typeof import(...)` type expressions

- **Symptom:** `pnpm check-types` fails with TS1005 "'{' expected" in files the
  author did not edit.
- **Cause:** `pnpm format` (Biome) appends a trailing comma inside
  `typeof import("path",)` type expressions; TypeScript rejects that syntax.
- **Safe response:** After a repo-wide format pass, remove trailing commas
  inside `import(...)` type expressions before trusting `check-types`.
- **Evidence:** 2026-09-12 format pass broke 4 files under
  `tests/integration/db/`; removing the commas restored a clean tsc run.

## Destructuring tool execute options breaks AI SDK tool() inference

- **Symptom:** `tool({ inputSchema: z.object(...), execute: async function*
  (input, { abortSignal }) {...} })` fails type checking with "ZodObject not
  assignable to FlexibleSchema<never>" (AI SDK 7, zod 4).
- **Cause:** Destructuring the second `ToolExecutionOptions` parameter defeats
  CONTEXT inference in `tool()`'s overloads.
- **Safe response:** Take the options object whole (`execute: async function*
  (input, options)`) and read `options.abortSignal` inside.
- **Evidence:** Bisected 2026-09-12 while building `spawn_subagent`; unedited
  options param type-checks, destructured param fails.

## Tools registered after run preparation are denied by policy authority

- **Symptom:** A tool bound to the chat agent right before `harness.stream`
  fails with `POLICY_DENIED` seconds after the model calls it, failing the
  entire run (agent_run error_code STREAM_ERROR), even though the model could
  see and invoke the tool.
- **Cause:** `resolvePolicy` builds `authority.capabilityIds` from
  `Object.keys(capabilities.tools)` captured at `preparationAdapter.prepare`
  time; policy evaluation is fail-closed, so a tool absent from that snapshot
  is denied at approval. `recall_memory` only escapes this because it is
  appended before prepare.
- **Safe response:** Register new chat tools before
  `preparationAdapter.prepare` (next to `recall_memory` in
  `src/app/api/chat/route.ts`). If the tool needs the runtime context, read it
  from tool execute `options.context` (ToolLoopAgent runtimeContext) instead
  of closing over `preparedRun.runtimeContext`.
- **Evidence:** 2026-09-12 live failure of `spawn_subagent`
  (agent_run `POLICY_DENIED`, reason `capability_outside_authority`); fixed by
  pre-prepare registration + execute-context context, verified by policy
  authority unit tests.

## 2026-09-12 — Physical table names differ from Drizzle export names

- TaskTable is `pgTable("iris_task", ...)` but exported as `TaskTable`.
  Hand-written SQL migrations must reference the physical name `iris_task`
  (and `workspace`), not the export name. Migration `0075_workspace_file.sql`
  initially used `"task"` and broke every integration suite with
  `relation "public.task" does not exist`.
- When hand-verifying migrations with `docker exec ... psql -f -`, the `-i`
  flag is required or stdin is not connected and psql exits 0 having run
  nothing — false green.
- `biome format --write` adds a trailing comma inside multi-line
  `typeof import("...")` type expressions (`typeof import("x",)`), which is a
  TypeScript syntax error. Repo convention is the
  `Awaited<ReturnType<typeof loadModule>>` pattern instead.

## AI SDK generator tools: the return value is discarded; last yield is final

- **Symptom:** A tool written as `async function* () { yield a; yield b;
  return final; }` produces tool output `b` (or `{}`), never `final`.
- **Cause:** `executeTool` (provider-utils) iterates generator yields with
  `for await`, emitting each as a preliminary output, then emits
  `{type: "final", output: lastYield}` — the generator's return value is
  never read.
- **Safe response:** Yield the final structured output as the LAST yield
  instead of returning it.
- **Evidence:** Found 2026-09-12 while wiring `spawn_subagent` streaming; the
  guarded-loop integration test showed the final output equal to the last
  yield.

## Capability-guarded tool wrapper collapses streaming (generator) tools

- **Symptom:** A generator tool wrapped by the guarded execute in
  `createToolLoopAgent` emits NO preliminary outputs and its tool part output
  serializes as `{}` — the UI shows only a spinner.
- **Cause:** The guarded wrapper is an `async function` that awaits
  `invokeCapability` and returns the generator object; the SDK's `executeTool`
  sees a Promise (not an async iterable), awaits it, and treats the generator
  object itself as the final output.
- **Safe response:** Keep the wrapper's streaming fast path: detect generator
  executes (`Symbol.toStringTag`/constructor name `AsyncGeneratorFunction`)
  and route them through an `async function*` guard that forwards yields and
  preserves return values while applying policy/budget/events, bypassing the
  capability scheduler (documented in `create-tool-loop-agent.ts`).
- **Evidence:** 2026-09-12 live failure ("subagent panel only loading") plus a
  fullStream integration test (`preliminary streaming through the guarded
  agent loop`) that fails without the fast path.

## 2026-09-12 — AI SDK v7 toolsContext is a per-tool map, not a shared object

- The AI SDK resolves every tool's execute `options.context` as
  `toolsContext[toolName]` (`getOwn(toolsContext, toolName)`). Passing
  `toolsContext: runtimeContext` (the shared object) yields `undefined`
  context for every tool. The chat route now sends
  `toolsContext: { [toolName]: runtimeContext }` for the tools that read it
  (`spawn_subagent`, `workspace_fs`). New tools that read
  `options.context` must be added to that map in `route.ts`, or their
  context-dependent behavior will silently fail closed.
- Any tool that reads `options.context` must fail closed with a structured
  `{ ok: false, error }` result when the context is missing — this is what
  surfaced the bug during harness-level integration testing.

## 2026-09-12 — Paired `call_00_`/`call_01_` tool parts are parallel model calls, not double execution

- **Symptom:** A chat reply shows the first tool (webSearch, recall_memory,
  spawn_subagent) invoked "twice". The tool call IDs are `call_00_*` and
  `call_01_*`, and both start within milliseconds of each other.
- **Cause:** The model emitted two parallel tool calls in one step; the
  provider indexes them `call_00`/`call_01`. Arguments differ (different
  queries), and each ID executes exactly once — verify via
  `iris_activity_event` (`tool.started`/`tool.completed` per toolCallId).
  There is no client resend: `sendAutomaticallyWhen` helpers only fire when the
  last step's tool parts all end `output-available`/`output-error` without a
  trailing text step.
- **Safe response:** Don't "fix" the loop. To force sequential single calls,
  disable parallel tool calls via provider options on the bound model.
- Related UI bug fixed the same day: `Chat.Tool.webSearchError` was referenced
  by `web-search.tsx` but missing from every `messages/*.json`, rendering
  next-intl `MISSING_MESSAGE` console errors whenever `part.errorText` was set.

## 2026-09-12 — Result-surface projection hides tool results from tool-invocation UI

- `projectCapabilityResultSurface` (wired into the chat driver since
  5dfc01f) replaces any tool output above the inline threshold (~8KB JSON)
  with `{ mode, artifact, downloadUrl, ownership, trust, provenance,
  summary|preview }` and stores the full payload as an artifact. UI
  components that cast `part.output` to the raw tool schema (e.g.
  `web-search.tsx` expecting `ExaSearchResponse.results`) silently render
  nothing — cards look stuck on their loading skeleton.
- **Safe response:** detect the stored surface (`mode` + `artifact.artifactId`)
  and fetch `/api/artifacts/{artifactId}` client-side (owner-scoped, returns
  the original JSON). Implemented in `web-search.tsx` via
  `useArtifactSearchResults`; reuse that hook for other tool cards as the
  projection covers every capability result.

## 2026-09-12 — Nested native toUIMessageStream masks real errors as "An error occurred."

- **Symptom:** The chat UI shows the generic `Chat Error / An error occurred.`
  and the user message is not saved, with no way to tell what actually failed.
- **Cause:** `POST /api/chat` merges the native harness stream with
  `result.toUIMessageStream({ messageMetadata })` and does not pass `onError`.
  The AI SDK's `toUIMessageStream` defaults to `onError = () => "An error
  occurred."` (see `node_modules/ai/dist/index.js`), so a failure inside the
  model/tool stream is reported with that exact generic string. The route's own
  `onError` on the outer `createUIMessageStream` only covers errors thrown by
  `execute`, not errors surfacing from the nested native stream. The string
  "An error occurred." appears nowhere in this repo, so seeing it in the UI
  means the nested stream's default fired.
- **Safe response:** when debugging a chat failure reported as "An error
  occurred.", read the server log and the `agent_run`/`iris_activity_event`
  `chat.failed` payload (`errorCode` + `message`) rather than the UI text.
  Passing an explicit `onError` to the nested `toUIMessageStream` would surface
  the real message, but leaks server error detail to the client — decide
  deliberately before doing so.
