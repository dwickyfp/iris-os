# System Settings Operations

## Contract

Runtime application settings live in PostgreSQL. **Admin > Settings** is the
operator surface. Sensitive values are encrypted with AES-256-GCM using a key
derived from `IRIS_ROOT_ENCRYPTION_KEY`; every mutation writes an audit row in
the same transaction and uses an optimistic revision.

The only application environment bootstrap exceptions are `POSTGRES_URL` and
`IRIS_ROOT_ENCRYPTION_KEY`. Process/platform values such as `NODE_ENV`, `PORT`,
`HOSTNAME`, reverse-proxy variables, CI controls, and migration-operation inputs
are not application settings.

## First setup

1. Apply all checked-in migrations with the explicit migration job.
2. Start web and workers with only the two bootstrap exceptions.
3. Sign in as an administrator.
4. Open `/admin/settings`.
5. Configure providers, Exa, OAuth, feature flags, memory modes, router limits,
   MCP policy, Redis, operations policy, and object storage.
6. Test and activate an object-storage profile before enabling uploads that must
   persist.

Settings marked restart-required affect singleton construction (for example,
Better Auth social providers or default role). Other public settings are
refreshed by web/worker processes within a bounded interval; saving one also
refreshes the local process immediately.

## Import from a pre-settings deployment

After migrations, with old variables still present in the importer's
environment:

```bash
pnpm settings:import-env
```

The importer:

- creates missing registry values;
- never overwrites an existing database value;
- validates every value through its Zod definition;
- encrypts sensitive values before persistence;
- imports former independent encryption keys as `legacy.*` secrets so existing
  model-provider and remote-agent ciphertext remains readable;
- creates an S3-compatible storage profile when complete legacy object-storage
  variables are present; profile creation does not activate storage.

It prints `created`, `already configured`, `imported`, or an invalid disposition.
It never prints secret material. Remove imported variables from the deployment
after verifying the application.

## Secret handling

- Administrative reads return secrets redacted; there is no reveal API.
- Decrypted secrets are not placed in the shared runtime settings cache.
- Better Auth and other restart-required consumers read decrypted settings
  during process initialization from PostgreSQL.
- Audit rows record key, operation, kind, revision, actor, and time—not plain
  values, ciphertext, or secret digests.
- All settings APIs return `Cache-Control: private, no-store`.

`IRIS_ROOT_ENCRYPTION_KEY` rotation is a coordinated recovery operation, not a
self-service setting rotation. Changing it without re-encrypting existing
envelopes will make stored secrets unreadable.

## Recovery

Database backups are incomplete for encrypted credentials without
`IRIS_ROOT_ENCRYPTION_KEY`; key backups are unusable without the database.
Restore both as a matched pair and test decryption of at least one provider
credential, remote-agent credential, and storage-profile credential before
serving traffic.
