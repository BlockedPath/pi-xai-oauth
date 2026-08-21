# Execution Progress — coverage pass (rebased 2026-08-22)

**Branch:** `chore/rebase-189` (rebase of `cursor/missing-test-coverage-7872` onto `main`)

## Previously landed on `main`

- [x] PR #190 (issue #188 streamed reasoning-mismatch recovery) merged as `8eaf274`.
- [x] v1.5.1 released via PR #192.
- [x] PR #195 merged: combined `vitest` + `@vitest/coverage-v8` 4.1.11 bump and Dependabot
      `groups` for the vitest packages and both Pi peers, superseding the split PRs #193/#194.

## Completed (this branch)

- [x] Inspected recent merges (#186/#187 coverage PRs already on main) and leftover gaps from the 2026-08-20 pass.
- [x] Added vision-routing image-shape normalization, computer-call association, and description-bound tests.
- [x] Added catalog post-rename `commitAllowed` restore plus 408/425/429/400 fetch classification.
- [x] Added image-edit validation/wire/session/network/JSON redaction tests.
- [x] Added custom media-tool generic catch redaction and missing-credential refusals.
- [x] Added OAuth already-aborted callback wait and cancel-during-catalog-handoff tests.
- [x] Rebased onto `main` after #190/#192/#195; only `.scaffold/progress.md` conflicted, all seven test
      files applied clean.
- [x] Re-verified on rebased `main`: `npm test` 55 files / 692 tests passed plus the real Pi loader
      smoke, and `npm run typecheck` passed.
- [x] Re-measured coverage against the current baseline: 90.93 / 84.89 / 93.30 / 94.14 on `main`
      rises to 92.17 / 86.87 / 93.30 / 95.41 with this branch.

## Notes

- The pre-rebase run reported 687 tests and 92.17 / 86.82 / 93.23 / 95.51; the deltas are #190's tests
  landing on `main` since the branch was cut, not a behavior change here.
- Packed `compatibility:boundaries` failed twice in the original cloud image on isolated `npm install`
  (`Cannot read properties of null (reading 'edgesOut')`) before tests ran — environment/npm installer,
  not a test flake. The hosted Pi 0.80.1 and 0.84.2 boundary jobs passed in CI.

## Next

Land the rebased coverage branch, then resume the regular coverage cadence against the remaining
`extensions/xai-oauth.ts` and `media/output-storage.ts` gaps.
