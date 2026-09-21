# Release Plan — v1.6.0

**Branch:** `release/v1.6.0`
**Base:** merged `main` at `3b9388b` (PR #223)

## Authorization and scope

The user requested a version update and npm publication through GitHub Actions. Use a minor release, 1.6.0, for the additive Grok 4.7 and usage CSV features accumulated since published 1.5.2. Include the already-merged catalog visibility, transcript compatibility, and reasoning recovery fixes. Keep Grok 4.6 defaults and the validated Pi range unchanged.

Use the existing `.github/workflows/publish.yml`: a published GitHub Release triggers validation, canonical npm publication through trusted publishing, and the exact scoped GitHub Packages mirror. Do not publish locally, change credentials, upload user screenshots, or make live xAI requests.

## Steps

1. [x] Verify clean synced main, latest published 1.5.2, available v1.6.0 name, and release-triggered publishing contract.
2. [x] Bump package/lock versions to 1.6.0 and finalize changelog/README release references without runtime/dependency changes.
3. [x] Run tests, typecheck, policy/package/mirror checks, and both clean packed Pi boundaries; inspect release diff.
4. [ ] Commit/push release branch, open a release PR, require successful CI/review triage, and merge into main.
5. [ ] Tag the verified main release commit and publish GitHub Release v1.6.0 to trigger Actions.
6. [ ] Monitor the exact publish run, verify npm latest/version/provenance and scoped mirror publication, and sync local main.

GitHub PR/release and Actions records are the authoritative delivery receipts. Record validation and any blockers in progress.md.
