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
