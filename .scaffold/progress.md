# Execution Progress — GitHub Packages mirror

**Branch:** `feature/github-packages-mirror`

## Completed

- [x] Published and verified canonical npmjs release `pi-xai-oauth@1.4.1` through GitHub Actions trusted publishing.
- [x] Confirmed GitHub Packages requires lowercase scoped npm names, creates the first package privately, and requires authenticated installs even after public visibility is enabled.
- [x] Selected dual publishing: canonical npmjs `pi-xai-oauth` plus GitHub Packages `@blockedpath/pi-xai-oauth`.
- [x] Selected 1.4.2 as the first mirror release rather than rewriting immutable 1.4.1 artifacts.
- [x] Made `bin/setup.js` read the installed distribution name and treat npmjs/GitHub/local aliases as one package.
- [x] Added setup regressions that prefer the active distribution and remove duplicate aliases.
- [x] Added single-canonical-tarball mirror preparation and archive parity verification for version, repository, peer range, setup identity, file paths, non-manifest bytes, and file modes.
- [x] Excluded local ignored agent, diagram, research, prototype, and probe artifacts from both package tarballs.
- [x] Extended CI and release publishing with `packages: write`, repository `GITHUB_TOKEN` authentication, scoped registry setup, and retry-safe version checks.
- [x] Bumped release metadata to 1.4.2 and documented first-package visibility plus authenticated GitHub Packages install/update instructions.
- [x] Replaced the browser callback test's fixed 10 ms ordering assumption with an assertion-driven wait; 10 focused stress runs and the exact 0.84.1 packed retry passed.
- [x] Independent review found no blocker; its medium archive-parity note was addressed and independently confirmed resolved.
- [x] Final local `npm test` passes: 51 files / 616 tests plus loader smoke.
- [x] `npm run typecheck`, `npm run compatibility:check`, 138-file canonical/mirror dry runs, `git diff --check`, workflow parsing, LSP, and pi-lens diagnostics pass.
- [x] Final clean packed exact Pi 0.80.1 and 0.84.1 boundaries each pass all 616 tests, loader smoke, and TypeScript at package version 1.4.2.

## In Progress

- Commit, push, and open the 1.4.2 dual-publishing PR.

## Next

Merge the reviewed PR, create GitHub Release `v1.4.2`, verify both registry publish steps, then change the new GitHub Package visibility to public once from its package settings.
