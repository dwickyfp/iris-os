# Repository Guidelines

## Project Structure & Module Organization
- App code lives in `src`.
  - `src/app` (Next.js routes, API, middleware)
  - `src/components` (UI; reusable components in PascalCase)
  - `src/lib` (helpers: auth, db, ai, validations, etc.)
  - `src/hooks` (React hooks: `useX`)
- Assets in `public/`. End‑to‑end tests in `tests/`. Scripts in `scripts/`. Docker files in `docker/`.

## Build, Test, and Development Commands
- `pnpm dev` — Run the app locally (Next.js dev server).
- `pnpm build` / `pnpm start` — Production build and run.
- `pnpm lint` / `pnpm lint:fix` — ESLint + Biome checks and autofix.
- `pnpm format` — Format with Biome.
- `pnpm test` / `pnpm test:watch` — Unit tests (Vitest).
- `pnpm test:e2e` — Playwright tests; uses `playwright.config.ts` webServer.
- DB: `pnpm db:push`, `pnpm db:studio`, `pnpm db:migrate` (Drizzle Kit).
- Docker: `pnpm docker-compose:up` / `:down` to run local stack.

## Coding Style & Naming Conventions
- TypeScript everywhere. Prefer `zod` for validation.
- Formatting via Biome: 2 spaces, LF, width 80, double quotes.
- Components: `PascalCase.tsx`; hooks/utilities: `camelCase.ts`.
- Co-locate small module tests next to code; larger suites under `tests/`.
- Keep modules focused; avoid circular deps; use `src/lib` for shared logic.

## Testing Guidelines
- Unit tests: Vitest, filename `*.test.ts(x)`.
- E2E: Playwright under `tests/`, filename `*.spec.ts`.
- Run locally: `pnpm test` and `pnpm test:e2e` (ensure app is running or let Playwright start via config).
- Add tests for new features and bug fixes; cover happy path + one failure mode.

## Commit & Pull Request Guidelines
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, etc. Example: `feat: add image generation tool`.
- Branch names: `feat/…`, `fix/…`, `chore/…`.
- PRs: clear description, linked issues, screenshots or terminal output when UI/CLI changes; list test coverage and manual steps.
- Before opening PR: `pnpm check` (lint+types+tests) should pass.

## Security & Configuration Tips
- Copy `.env.example` to `.env`; never commit secrets. For local HTTP use `NO_HTTPS=1` or `pnpm build:local`.
- If using DB/Redis locally, start services via Docker scripts or your own stack.

<!-- repo-learning-loop:start -->
## Repository learning and workstream continuity

This repository uses the Repo Learning Loop plugin.

Before meaningful repository work:

1. Read `.agent/MEMORY.md` and relevant durable notes.
2. Check `.agent/workstreams/active/` for a matching workstream.
3. For multi-step work, create or resume a workstream before implementation.
4. Validate recorded checkpoint state against the current branch, HEAD, and working tree.

During multi-step work:

1. Keep `PLAN.md` aligned with the actual implementation.
2. Checkpoint only after a semantic step is verified.
3. Record the exact next action, relevant files, and verification command.
4. Never overwrite another live session lease without explicit reconciliation.

Before stopping after repository changes:

1. Run applicable verification.
2. Update the active checkpoint or record a learning review.
3. Classify durable findings as repository memory, decision, known trap, automation, or skill candidate.
4. Never publish a generated skill directly; create and evaluate a candidate first.

Before completing or abandoning a workstream:

1. Verify the terminal state.
2. Extract durable knowledge before archiving transient checkpoint data.
3. Use two-phase cleanup: archive, then trash, then hard-delete after retention.
<!-- repo-learning-loop:end -->
