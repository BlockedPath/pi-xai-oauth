# Execution Progress — v1.5.2 release

**Branch:** `release/v1.5.2`

## Previously landed on `main`

- [x] v1.5.1 released via PR #192 and GitHub Release `v1.5.1`.
- [x] PR #195 merged: combined `vitest` + `@vitest/coverage-v8` 4.1.11 bump.
- [x] PR #196 / #197: coverage regressions plus quieter Vitest output.
- [x] PR #198: raised V8 coverage floors to the measured baseline.
- [x] PR #199: stopped agent formatter churn and pinned the packed-test requirement.
- [x] PR #201: pinned streamed HTTP 400 mismatch classification.
- [x] PR #202 (issue #200): Grok-native reads/writes through checked descriptors.

## Completed (this branch)

- [x] Bumped package and lock metadata to 1.5.2.
- [x] Finalized the Grok-native descriptor-I/O changelog entry.
- [x] Updated README latest-release and Updating version references.
- [x] Passed `npm test` (696 tests), `npm run typecheck`, `npm run compatibility:check`, both exact Pi 0.80.1/0.84.2 packed boundaries, `npm pack --dry-run --json` (147 files), and `git diff --check` for v1.5.2.

## In Progress

- [ ] Merge the release PR, publish GitHub Release `v1.5.2`, and monitor both registry publish steps.

## Next

Publish v1.5.2 through the GitHub Release workflow (`publish.yml`).
