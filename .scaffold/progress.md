# Execution Progress — Pi 0.84.1 compatibility

**Branch:** `feature/pi-0.84.1-compat`

## Completed

- [x] Confirmed all three public acceptance seams with the user: OAuth persistence/cancellation, catalog publication, and exact packed matrices.
- [x] Reproduced the pre-fix Pi 0.84.1 candidate result and isolated its cancellation/catalog compatibility failures.
- [x] Added a red-green regression proving Pi's concrete refresh signal reaches the xAI token exchange, then forwarded it through `createXaiOAuth().refreshToken`.
- [x] Added a real file-backed rollover regression proving request preparation persists refreshed access and rotated refresh credentials before use on both the legacy 0.80.1 registry and current 0.84.1 ModelRuntime.
- [x] Adapted cancellation and stored-catalog publication tests across the 0.80.1 and 0.84.1 contracts.
- [x] Widened aligned peers to `>=0.80.1 <0.85.0`, pinned exact development dependencies/policy to 0.84.1, and updated the lockfile, README, changelog, and package exclusions.
- [x] Excluded caller-owned local research, prototype, and probe artifacts from npm tarballs without deleting or tracking them.
- [x] Independent review found no blocker. Addressed all three notes: rejection-sensitive cancellation assertion, minimum-boundary file persistence coverage, and local artifact packaging exclusions.
- [x] Final local `npm test` passes: 50 files / 613 tests plus loader smoke.
- [x] `npm run typecheck`, `npm run compatibility:check`, `git diff --check`, and edited-file LSP diagnostics pass.
- [x] Clean packed exact Pi 0.80.1 and 0.84.1 boundaries each pass all 613 tests, loader smoke, and TypeScript.

## In Progress

- None.

## Next

Commit the reviewed diff, push the feature branch, and open a pull request. Do not include caller-owned untracked probe/research/prototype files.
