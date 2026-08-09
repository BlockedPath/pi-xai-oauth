# Release Progress — 1.4.1

**Branch:** `release/1.4.1`

## Completed

- [x] Merged Pi 0.84.1 OAuth refresh and catalog lifecycle compatibility in PR #171.
- [x] Bumped `package.json` and `package-lock.json` from 1.4.0 to 1.4.1.
- [x] Finalized the 1.4.1 changelog and README release text.
- [x] Replaced the placeholder publish workflow with a GitHub Release-triggered npm trusted-publishing workflow using OIDC, least-privilege permissions, release-tag/version validation, main-ancestry validation, and the full release gates.
- [x] Documented npmjs.com trusted-publisher setup and the GitHub Release procedure.
- [x] Removed live built-in catalog I/O from the Pi 0.84 store-publication test, kept credential refresh outside the test's scope, and awaited the exact registration-triggered publication promise.
- [x] Stress-ran the focused registry suite 15 times after isolation; all runs passed.
- [x] Independent follow-up review confirmed the publication test and trusted-publishing workflow are correct with no blocker.
- [x] Local `npm test` passes: 50 files / 613 tests plus loader smoke.
- [x] `npm run typecheck`, `npm run compatibility:check`, `npm pack --dry-run --json`, `git diff --check`, LSP, and pi-lens diagnostics pass.
- [x] Clean packed exact Pi 0.80.1 and 0.84.1 boundaries each pass all 613 tests, loader smoke, and TypeScript at package version 1.4.1.

## In Progress

- None.

## Next

Commit and merge the 1.4.1 release PR. On npmjs.com, configure the `pi-xai-oauth` trusted publisher for `BlockedPath/pi-xai-oauth`, workflow `publish.yml`, with `npm publish` allowed. Then publish a non-prerelease GitHub Release tagged `v1.4.1`; GitHub Actions will revalidate and publish to npm.
