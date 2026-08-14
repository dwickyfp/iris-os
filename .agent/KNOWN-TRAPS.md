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
