# Migration Operations

These commands create release evidence. They do not authorize production
migration execution. Database operations never read `POSTGRES_URL`; each target
must use a dedicated `MIGRATION_*` URL and exact database-name confirmation.
Application startup and package installation never run migrations. Production
migrations must run as an explicit `pnpm db:migrate` deployment job using a
dedicated migration database role before web and worker processes start.

## Safety Model

- Allowed target kinds are `disposable` and `staging-snapshot` only.
- Names and hosts containing `prod`, `production`, or `live` are rejected.
- Add comma-separated database names or hosts to
  `MIGRATION_DATABASE_DENYLIST` for environment-specific protection.
- `staging-snapshot` requires a non-empty `MIGRATION_SNAPSHOT_RECEIPT`, such as
  an immutable backup object version, checksum, and capture timestamp.
- Operations use a session advisory lock, a 5-second lock timeout, and a
  15-minute statement timeout.
- Evidence contains database and snapshot-binding hashes, never URLs, credentials,
  database names, or raw receipts.
- There is no force or bypass option. A failed check requires new evidence.

## Disposable Topology

Start two in-memory PostgreSQL databases for a local rehearsal and restore
drill:

```bash
docker compose -f docker/compose.migration-rehearsal.yml up -d --wait
```

Remove them after the drill:

```bash
docker compose -f docker/compose.migration-rehearsal.yml down
```

## Rehearsal

For an empty disposable database:

```bash
MIGRATION_DATABASE_URL=postgresql://iris:rehearsal-only@127.0.0.1:55432/iris_rehearsal \
MIGRATION_TARGET_KIND=disposable \
MIGRATION_CONFIRM_DATABASE=iris_rehearsal \
pnpm migration:rehearse
```

For a representative staging snapshot, restore the snapshot into a separate
database first, then use `MIGRATION_TARGET_KIND=staging-snapshot` and set
`MIGRATION_SNAPSHOT_RECEIPT`. Never rehearse against the live staging database.

The rehearsal records every migration SHA-256, the aggregate migration-set
hash, a conservative SQL hazard inventory, duration, aggregate row estimates,
and read-only integrity results. Hazards are review inputs, not automatic proof
of safety.

## Integrity

Run the read-only aggregate checks independently after rehearsal:

```bash
MIGRATION_DATABASE_URL=postgresql://iris:rehearsal-only@127.0.0.1:55432/iris_rehearsal \
MIGRATION_TARGET_KIND=disposable \
MIGRATION_CONFIRM_DATABASE=iris_rehearsal \
pnpm migration:integrity
```

The checks cover unvalidated constraints and applicable scope, orphan,
cross-owner, artifact-ownership, and verification invariants. A non-zero
violation count fails evidence.

## Rollback Drill

The drill takes a logical backup of the rehearsal source and restores it only
into a second disposable target. It then reruns integrity checks and executes a
behavior probe proving every V2 feature flag resolves off.

```bash
MIGRATION_DATABASE_URL=postgresql://iris:rehearsal-only@127.0.0.1:55432/iris_rehearsal \
MIGRATION_TARGET_KIND=disposable \
MIGRATION_CONFIRM_DATABASE=iris_rehearsal \
MIGRATION_RESTORE_DATABASE_URL=postgresql://iris:restore-only@127.0.0.1:55433/iris_restore_drill \
MIGRATION_RESTORE_TARGET_KIND=disposable \
MIGRATION_RESTORE_CONFIRM_DATABASE=iris_restore_drill \
pnpm migration:rollback-drill
```

The command uses installed `pg_dump` and `pg_restore` binaries when available.
Otherwise it runs matching pg17 tools in Docker; override the image with
`MIGRATION_PG_TOOLS_IMAGE` if necessary. Set `MIGRATION_BACKUP_FILE` to a
reviewed custom-format dump to skip dump creation; restoration remains limited
to the second confirmed disposable database.

Schema rollback remains forward-fix only. The drill verifies recoverability and
flags-off behavior, not a destructive down migration.

## Rollout Gate

Evidence is written to `artifacts/migration-operations` by default. Set
`MIGRATION_EVIDENCE_DIR` consistently to use another directory. The gate reads
only `rehearsal`, `integrity`, and `rollback-drill` JSON evidence and SHA-256
files. It recomputes the migration-set hash from the checked-in SQL and requires
every evidence file to match it. Rehearsal and integrity `databaseHash` values
must match, rollback `sourceDatabaseHash` must identify that same database, and
all three operations must carry the same `snapshotBindingHash` (or all carry
`null` for an empty disposable rehearsal).

```bash
pnpm migration:rollout-gate
```

For a staging rollout, require evidence from a representative snapshot and its
receipt:

```bash
MIGRATION_ROLLOUT_POLICY=staging pnpm migration:rollout-gate
```

The default `disposable` policy supports local gate testing. Release promotion
through staging must use the `staging` policy; it requires rehearsal evidence
with `targetKind=staging-snapshot` and the same sealed, non-empty
`snapshotBindingHash` across rehearsal, integrity, and rollback evidence. Pass
the exact same `MIGRATION_SNAPSHOT_RECEIPT` to all three commands.

The gate does not accept a database URL and does not connect to PostgreSQL. Its
own JSON, Markdown, and SHA-256 result can be attached to the release record.

## Evidence Review

Before rollout, verify:

1. The staging gate confirms the snapshot receipt identifies a representative,
   recent snapshot.
2. Every hazard has an operator assessment and an acceptable lock/runtime plan.
3. Rehearsal and integrity row counts have no unexplained loss.
4. Restore evidence came from a distinct disposable database.
5. All V2 flags remain off until the separate application rollout decision.
6. The rollout gate passes without editing evidence or using an override.
