# Upstream provenance

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b (upstream HEAD at install time, 2026-09-12)
- Installed via: `npx skills add dmmulroy/anti-slop --skill install-anti-slop`, then `.agents/skills/install-anti-slop/scripts/install.mjs`
- Installed paths: `tools/oxlint/anti-slop/` (including vendored `vendor/eslint-stylistic/LICENSE`)
- Dependencies: `oxlint@1.82.0`, `@oxlint/plugins@1.82.0` (pinned exactly, devDependencies)
- Configuration: `.oxlintrc.json` (generic plugin registered via `jsPlugins`, all generic rules at `"error"`). A `.ts` config was not used because `oxlint@1.82.0` does not export `oxlint/config`.
- Effect plugin: NOT enabled (no direct `effect` dependency in package.json).
- Intentional deviations: agent tooling directories (`.zcode/**`) added to `ignorePatterns` in addition to the skill's default list.
