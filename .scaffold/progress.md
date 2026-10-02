# Execution Progress — v1.6.1 release

**Branch:** `release/v1.6.1` (from `main` @ 7cf8059)

## Completed

- [x] Confirmed `main` was current with `origin/main` and no release-relevant PR was open.
- [x] Live smoke of `main` on Pi 1.0.0 (only this extension loaded, `xai-auth`): plain turn, `read_file` tool turn, same-model continue, switch to Grok 4.7, and Grok 4.3 `--thinking minimal` all passed.
- [x] Bumped `package.json` and both root lockfile version fields to 1.6.1; no dependency or runtime changes.
- [x] Dated the Unreleased changelog as 1.6.1 (2026-10-02) and updated the README release, compatibility, and updating guidance.

## In Progress

- [ ] Release PR: run `npm test`, `npm run typecheck`, `npm run compatibility:check`, `npm run compatibility:boundaries`, `npm pack --dry-run`, `git diff --check`.

## Next

After CI and merge, publish GitHub Release `v1.6.1` on the merged `main` commit; `publish.yml` validates and publishes npmjs `pi-xai-oauth` and the GitHub Packages mirror `@blockedpath/pi-xai-oauth`.

## Follow-ups

- Known metadata for `grok-4.7-build-fast` (entitled accounts currently get conservative defaults: 16.4K max output, text-only).
