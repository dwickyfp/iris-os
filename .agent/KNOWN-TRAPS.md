# Known Traps

Record verified repository-specific failure patterns that future sessions could repeat.
Include symptoms, cause, safe response, and verification evidence.

## `pnpm check` rewrites files

- **Symptom:** Running the nominal aggregate check can modify source files.
- **Cause:** `package.json` defines `check` with `pnpm lint:fix`.
- **Safe response:** For read-only verification run `pnpm lint`,
  `pnpm check-types`, and `pnpm test` separately.
- **Evidence:** Verified from the current `package.json` on 2026-08-14.
