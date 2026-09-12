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
