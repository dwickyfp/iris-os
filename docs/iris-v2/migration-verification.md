# IRIS V2 Migration Verification

## Supported verification paths

Run `pnpm test:integration:db` to start a disposable
`pgvector/pgvector:pg17` container. Set `TEST_POSTGRES_URL` to use an existing
disposable PostgreSQL instance instead. Never point this command at production.

The suite verifies:

- all migrations apply to an empty database;
- a legacy database migrated through `0021` can be seeded and upgraded;
- legacy `fact` memory becomes global `semantic` memory;
- topic, entity, edge, evidence, embedding, curator, and retrieval audit rows
  retain valid global scope;
- global `NULL` exact-scope uniqueness is enforced;
- invalid scope pairs and cross-scope/cross-user edges are rejected.

## Forward-fix policy

Migrations `0021` through `0027` are immutable. Integrity gaps discovered by
the executable suite are corrected by additive migrations beginning with
`0028_v2_integrity_hardening.sql`. Behavioral rollback uses the V2 feature
flags; schema rollback uses a reviewed forward migration.

Before deploying migrations, snapshot the target database and record row counts
for each scoped memory table. After migration, run orphan, invalid-scope,
duplicate exact-scope, cross-user, cross-scope edge, and stale thread/task
queries. Any unexplained row loss blocks rollout.
