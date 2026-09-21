# Execution Progress — v1.6.0 release

**Active branch:** `release/v1.6.0`

- PR #223 merged as `3b9388b`; local main was clean and synced. The user explicitly requested a version update and npm publication through GitHub Actions.
- Confirmed latest npm/GitHub release is 1.5.2 and v1.6.0 has no existing remote tag or branch. A minor release follows the additive Grok 4.7/catalog and usage CSV features already merged since 1.5.2.
- Read the existing `release.published` workflow: release commit must be on main, tag must match package version, all validation gates run, then the canonical archive is published to npm through trusted publishing and mirrored exactly as `@blockedpath/pi-xai-oauth` on GitHub Packages. No local npm publish or workflow changes are planned.
- Created `release/v1.6.0`, aligned manifest/lock root versions, finalized the 2026-09-21 changelog, and updated README release/compatibility guidance. No runtime code or dependency versions changed.
- Release validation passed: `npm test` (850 tests + real loader), typecheck, full policy/registry/163-file-pack/negative-peer/mirror checks, and both clean packed boundaries. Pi 0.80.1 passed 846 tests (four intentional skips); Pi 0.86.1 passed 849 (one Git-only skip); both loaders/typechecks passed. Logs: `/tmp/pi-xai-v1.6.0-{test,compatibility,boundaries}.log`.
- Reviewed the release diff: six files, version-only manifest/lock changes, finalized release docs, and scaffold state; no runtime or dependency changes. Whitespace and manifest/lock version checks passed.
- Ready for release PR delivery. Publish only after that PR passes CI/review triage, is merged, and its exact main commit is tagged. GitHub PR/release and Actions records will provide final delivery evidence; no live xAI requests or credential changes are part of this release.

## Previous progress — Grok 4.7 support

**Branch:** `feature/grok-4-7`

- Read provider registration, model metadata/codec, custom tools, setup, README, and repository rules on clean `main`; created the feature branch before edits.
- Official overview/model/reasoning/pricing docs confirm `grok-4.7`, text+image input, 500K context, $2/$0.50/$6 per million input/cache-read/output tokens below 200K input, and low/medium/high/xhigh reasoning (default high, not disableable).
- Public documentation does not establish OAuth account entitlement. Add known metadata and reasoning compatibility only; keep exact authenticated membership, Grok 4.6 offline/setup defaults, prior models, and user selections unchanged. No unverified aliases or Fast route.
- Source evidence will be recorded in README. No live authenticated xAI requests or credential access planned.
- Added regressions first: focused run failed on seven missing Grok 4.7 behaviors. Implemented known metadata, authenticated minimal-to-low mapping, reasoning detection, and high-by-default text generation.
- Focused suites now pass 128 tests, including real Pi streaming-delegate dispatch at low/medium/high/xhigh and rejection of an unentitled Grok 4.7 request before network. Typecheck passes; initial active primary LSP checks found no errors.
- README/Unreleased changelog document source evidence, short-context pricing vs long-context rates, the output-limit placeholder, unchanged defaults, and the restricted Fast service. AGENTS overview reflects entitlement-gated support.
- Automated scanner also flagged pre-existing dictionary typing in the touched tool module: tightened the two payload dictionaries from any to unknown without runtime changes. Its raw catalog-accessor warning is locally annotated because unknown is intentional until callers validate it.
- Grok 4.7 validation passed: `npm test` (827 tests + loader), `npm run typecheck`, active primary LSP on nine changed TS files, and final scoped diff/whitespace review.
- Both clean packed Pi 0.80.1/0.85.1 boundaries passed 826 tests (one intentional Git-only skip), loader, and typecheck. The first minimum run hit the existing one-second terminal metadata-test timeout under host load ~34; the focused test and unchanged full matrix retry passed. Logs: `/tmp/pi-xai-grok47-{test,boundaries,boundaries-retry}.log`.
- User reports that Pi is on 0.86.1. Parent inferred a compatibility follow-up, but explicit approval to migrate/widen policy is pending. Registry confirms aligned 0.86.1 peers. The clean packed candidate passes 826 tests + loader but fails `tsc` at `extensions/xai/responses.ts:413`: Context lacks the new TranscriptContext brand. Candidate log: `/tmp/pi-xai-pi0861-candidate.log`.
- Upstream 0.86.0 explicitly changes provider inputs to normalized transcript contexts with system messages carrying tools/prompts; a type assertion alone is not an adequate migration. The existing minimum 0.80.1 must keep working.
- Read-only scout → independent plan-review workflow `f5e7b100-5e32-494e-8e0e-3bc698f78d73` is inspecting the upstream boundary before implementation. Parent is sole writer. Pre-migration patch captured at `/tmp/pi-xai-grok47-before-pi0861.patch`.
- Paused to clarify the inferred compatibility scope; user explicitly selected “Include Pi 0.86.1 (Recommended)” (adapter migration, bounded peer update, old/new validation). Work may now proceed. Grok 4.7 remains independently validated against the existing boundaries.
- Scout completed upstream tarball inspection. Parent verified `normalizeContext` source and rejects the scout's manual legacy folding/type-import suggestions: old Pi must receive its original top-level context; only new Pi should use its native normalizer, with the delegate argument type derived instead of importing unavailable old-version types. Independent reviewer is checking the plan.
- Moved the scout's accidentally repository-rooted public npm tarball into `/tmp/pi0861-work/`; no source or credential changes came from the scout.
- Independent pre-implementation review blocked the scout's legacy manual-folding fallback and missing policy collateral. Parent resolved both: only Pi 0.86 uses its native normalizer; older delegates retain top-level prompt/tools. Context typing is inferred from the installed delegate; no unavailable named export is imported.
- Added `tests/responses/transcript-context.test.ts`: legacy prompts/tools/empty context on every version, plus actual Pi 0.86 normalized contexts, system sections/tool deltas, same-model reasoning replay and mismatch retry, and input immutability. Before the adapter, 0.86.1 failed three runtime assertions (lost prompt/tools), proving the incompatibility beyond TypeScript. Afterward: legacy Responses suite passed 154 tests (three intentional transcript-only skips), root 0.85.1 typecheck passed, and active primary LSP was clean.
- Clean packed **0.86.0 and 0.86.1 candidates both passed**: 834 tests + one Git-only skip, real loader and typecheck. Logs: `/tmp/pi-xai-pi0860-candidate.log`, `/tmp/pi-xai-pi0861-candidate-green.log`; red runtime reproduction: `/tmp/pi-xai-pi0861-context-red.log`.
- Updated policy/peers to `>=0.80.1 <0.85.0 || >=0.85.1 <0.87.0`, latest/dev pins to 0.86.1, upper negative sentinel to 0.87.0; retained minimum 0.80.1 and excluded 0.85.0. Regenerated the lock using CI's npm 11.6.2 with strict peers; substantial transitive changes come from Pi 0.86.1's updated exact SDK dependencies. Updated policy tests and docs. CI already derives exact endpoints from policy, so no workflow edit is necessary.
- Final validation passed on the complete change:
  - `npm test`: **837/837 tests**, plus real loader smoke; `npm run typecheck` passed with Pi 0.86.1.
  - `npm run test:coverage`: 92.45% statements / 87.34% branches / 93.16% functions / 95.64% lines, all floors passed.
  - `npm run compatibility:check`: policy, registry latest, 162-file pack, strict rejection/forced warnings for 0.79.10, 0.85.0 and 0.87.0, and exact GitHub Packages mirror parity all passed.
  - Clean packed boundaries: **0.80.1: 833 passed, four intentional skips** (Git-only pack test and three 0.86-only transcript cases); **0.86.1: 836 passed, one Git-only skip**. Both real loaders and typechecks passed.
  - Active primary LSP checked all twelve touched TS files: no diagnostics. Parent reviewed production/config/docs diff and generated Pi dependency changes; whitespace checks passed, including the new test file.
  - Logs: `/tmp/pi-xai-final-test.log`, `/tmp/pi-xai-final-coverage.log`, `/tmp/pi-xai-final-compatibility.log`, `/tmp/pi-xai-final-boundaries.log`.
- Complete on `feature/grok-4-7`; no live OAuth probe, commit, push, or publication. Remaining limitations: actual account entitlement is server-authoritative; the documented Grok 4.7 output ceiling is still a compatibility placeholder until authenticated limits override it.

## Delivery authorization — Grok 4.7 and Pi 0.86.1

- User explicitly requested committing and opening a PR after validation. No merge or package release is authorized.
- Pre-commit fetch confirms `origin/main` still matches base `22be9be`; no existing PR targets `feature/grok-4-7`.
- Verified the final test/typecheck/packed-boundary evidence above and reviewed the scoped twenty-file change, including the new transcript-context suite. Only delivery notes changed after those gates.
- Created an initial local commit for Grok 4.7 and Pi 0.86.1 (later amended and published as `3a545ff2aa26440fc5c12a0d24ff097f8c6077d4`). Before push/PR, user paused delivery: Grok 4.7 was missing when testing this local checkout under `xai-auth`. At that point nothing had been pushed and no PR existed.
- Offline diagnosis: the valid, non-invalidated token-free cache was four minutes old and contained only `grok-4.6` and `grok-4.5`. Replaying that normalized snapshot through the real selection/alias path in an isolated temporary cache produced `source: fresh-cache` and no Grok 4.7 (membership assertion exited 2), with network disabled and no credential access. This reproduces the missing registration but does not establish whether the server omitted 4.7 or normalization rejected it.
- The original synthetic registration regression passed, but did not reproduce the actual limits. User explicitly authorized two separate bounded read-only `/models-v2` probes. First: HTTP 200, Grok 4.7 present in the response but classified malformed. Second: allowlisted metadata shows `context_window: 500000` and `max_completion_tokens: 1000000`; the only failed validation is completion > context. Omitting just that limit makes normalization accept the entry. No raw body/headers/identity/tokens were logged or saved; no cache/credential writes or generation requests occurred.
- Added a minimal four-field, token-free metadata fixture and regressions at normalization, forced-refresh/cache-reload, and real provider-registration seams. The focused command `npm run test:unit -- tests/catalog/normalization.test.ts tests/catalog/cache.test.ts tests/provider/catalog-lifecycle.test.ts` reproduced four failures, including fallback Grok 4.6 instead of registered Grok 4.7 (log `/tmp/pi-xai-grok47-limits-red.log`).
- Fixed the relationship check: require a positive safe completion integer under the unchanged absolute 1M cap, then use the existing `Math.min(..., contextWindow)` clamp. Cache validation stays strict and receives only normalized limits. Updated the old oversized-output negative fixture to exceed the absolute cap, and added explicit invalid-number/type/boundary tests.
- Focused suites now pass all 63 tests; typecheck passes. Docs now distinguish the missing-limit default from observed independent catalog limits and explain refreshing a previously filtered cache.
- Full revalidation passed after the fix: 849 tests + loader, typecheck, unchanged coverage floors (92.45% statements / 87.34% branches / 93.16% functions / 95.64% lines), active primary LSP on five touched TS files, parent diff/whitespace review, and full policy/registry/163-file-pack/negative-peer/mirror checks. Packed boundaries passed at Pi 0.80.1 (845 passed, four intentional skips) and 0.86.1 (848 passed, one Git-only skip), each with loader and typecheck. Logs: `/tmp/pi-xai-grok47-limits-{test,coverage,boundaries,compatibility}.log`.
- Removed generated `.vitest` output from the repository; the sole new fixture contains four allowlisted model metadata fields, not a raw catalog response. A final offline replay normalizes Grok 4.7 to contextWindow/maxTokens 500000/500000.
- User supplied a screenshot confirming `grok-4.7 [xai-auth]` is now visible in the selector. The live-UI confirmation resolves the delivery pause; resume the original commit/push/PR request. No third authenticated probe is authorized or performed, and no live generation was tested.
- Published the complete catalog-limit fix in feature commit `3a545ff2aa26440fc5c12a0d24ff097f8c6077d4` and opened PR #223 against `main` at base `22be9be`. The initial local commit was amended before publishing; it is not part of the shared history. The user's screenshot remains local; only the confirmation is recorded.

## Pre-merge review — PR #223

- User conditionally authorized merge and local-main synchronization if all checks are good. No release or additional live probe is authorized.
- All CI/security checks passed on `3a545ff`. Audited both CodeRabbit findings: the final delivery instruction was stale after the local amend, and `xai_generate_text` genuinely omitted `xhigh` from its schema (`extensions/xai/tools/custom-tools.ts:66`). The bot's generic docstring-percentage warning is advisory; repository policy requires documentation of exported functions, already present on the touched public functions.
- Added a regression using Pi's actual `validateToolArguments()` before dispatch. It failed with `reasoning_effort: must be equal to one of the allowed values`; adding `xhigh` to the enum fixes validation and dispatch while `max` remains rejected. All 57 custom-tool tests and typecheck pass. The local scanner also requested explicit types on two existing evolving-any input locals in this touched module; those now derive from the respective validators without runtime changes.
- Pre-commit revalidation passed: 850 tests + real loader, typecheck, coverage floors, active primary LSP on both changed TS files, whitespace/diff review, and full policy/registry/163-file-pack/negative-peer/mirror checks. Packed Pi 0.80.1 passed 846 tests (four intentional skips) and Pi 0.86.1 passed 849 (one Git-only skip); both loaders/typechecks passed. Logs: `/tmp/pi-xai-pr223-review-{test,boundaries,coverage,compatibility}.log`.
- Push this narrow review follow-up, record the dispositions on PR #223, and require fresh CI before the user-authorized merge and fast-forward-only local-main sync. GitHub PR #223 is the authoritative final check/merge receipt; no package release is authorized.

## Previous progress — Issue #220: same-turn reasoning recovery

**Active branch:** `feature/issue-220-reasoning-retry`

- Identified the sole open issue #220 and read its full body/comments; base is synced `main` at `6b619c5`.
- Refreshed dependencies with `npm ci`; the existing reasoning-recovery suite passes all 6 tests.
- Reproduced the requested failure with `npm run test:unit -- tests/responses/reasoning-recovery.test.ts -t 'retries a mismatch in the same turn'`: expected a successful retry result, received `stopReason: error`.
- Parallel read-only test planning and pre-implementation review completed in workflow `2d2820ff-c2de-45d7-806e-433633bc7259`; parent is sole writer. Accepted the review's bounded-attempt design and all required guards. Durable review artifacts remain in the session's `subagent-artifacts` directory (scout `6bb0cb72-46e3-4323-8658-814135cebbab`, reviewer `b0c46a77-169d-4804-96b6-06acae8b86db`).
- Confirmed root cause: the pump forwarded the first classified terminal error, settling the outer result before any same-turn recovery. Existing classification and omission already worked.
- Implemented a two-attempt pump with final-payload reasoning detection, buffered start/error suppression, fresh per-attempt request IDs, per-attempt tool routes, retained redirect guard, repeated hooks/local validation, and cancellation/content guards. Failed network retries preserve exact guidance for next-turn recovery; local validation and cancellation remain distinct.
- Focused recovery suite passes 32 tests; typecheck and active primary LSP checks pass. Regressions cover HTTP/SSE mismatch success, bounded retry failures, redaction, text/thinking/tool output, hook reconstruction, no reasoning/cross-model/API/provider/history omission, unrelated failures, cancellation, catalog invalidation, and later replay.
- Updated README, wire-protocol contract, and Unreleased changelog. No live xAI traffic or publication was performed.
- The first minimum-Pi boundary run caught three new SSE fixture defects: Pi 0.80.1 requires `response.content_part.added` / `response.reasoning_summary_part.added` before deltas. Added those real protocol events without weakening assertions; both boundaries then passed.
- Final validation passed: `npm test` (814 tests plus real loader), `npm run typecheck`, `npm run test:coverage` (92.47% statements / 87.26% branches / 93.16% functions / 95.66% lines), `npm run compatibility:check` (registry/pack/unsupported peers/mirror), active primary LSP diagnostics (two changed TS files, zero findings), and `git diff --check`.
- Exact clean packed Pi 0.80.1 and 0.85.1 boundaries each passed 813 tests plus one intentional Git-only skip, real loader, and typecheck. Logs: `/tmp/pi-xai-issue-220-{test,coverage,boundaries,compatibility}.log`.
- Final parent review confirmed every pre-implementation review guard is represented in code/tests; removed generated `.vitest` output and scratch scout/reviewer copies from the repository, retaining session-managed artifacts. Implementation is complete and uncommitted on the feature branch.

## Parallel code review — Issue #220

- User requested parallel subagent review; no PR exists yet, so reviewers inspected the local candidate diff against `6b619c5` (SHA256 `f17a24427219a69010f5fd8145a201eabf2523922d2d814191b1f2e652e8ffd3`). Confirmed that exact diff remained unchanged through review.
- Workflow `7f2578da-ae60-41e8-924d-37ab5bdef4cf` ran two independent fresh-context read-only reviewers. Standards/safety: zero findings, verdict OK (`f1669efb-c879-4b09-9b88-911282e21eb9`). Spec/correctness: zero findings, verdict OK (`41104ce8-5b4d-4c7a-90c4-ac3c8c6c81e5`). Full reports remain in the session-managed `subagent-artifacts` directory.
- Parent additionally ran the recovery, streaming, and vision suites with `NODE_OPTIONS=--unhandled-rejections=strict`: all 63 tests passed. No live xAI traffic, code changes, commits, or GitHub mutations during review.

## Delivery authorization — Issue #220

- User approved committing, pushing, and opening the PR after both independent reviewers returned OK. No merge or release is authorized.
- Pre-commit fetch confirms `origin/main` remains at the reviewed base `6b619c5`; implementation/tests/docs match the reviewed diff, with only subsequent scaffold review/delivery notes added.
- Required test/typecheck/packed-boundary evidence is verified above; publish the scoped seven-file change on `feature/issue-220-reasoning-retry` with a PR closing #220.

## Previous progress — PR #216: Pi 0.85.1 compatibility

**Active branch:** `dependabot/npm_and_yarn/pi-peers-973734b516`

- Independent pre-implementation review approved bounded disjoint peer intervals and explicit negative npm fixtures for known-broken releases.
- Preserve existing support, add Pi 0.85.1, and exclude 0.85.0: `>=0.80.1 <0.85.0 || >=0.85.1 <0.86.0`.
- Extend plain-Node policy validation for ordered ranges, boundary alignment, exclusions, and negative install tests; add focused policy regressions.
- Remove obsolete host-catalog membership assumptions while retaining unconditional OAuth metadata exclusion and catalog rejection for `grok-build-0.1`.
- Document the unreleased range separately from published 1.5.2 and explain the 0.85.0 SDK packaging failure.
- Regenerated lock metadata with npm 11.6.2; both manifest/lock peer unions match, with both development Pi versions exactly 0.85.1.
- Local Linux Node 24.19.0 / npm 11.6.2 gates passed: 788 tests, real loader, typecheck, unchanged coverage floors, and both clean packed Pi 0.80.1/0.85.1 boundaries (787 passing tests plus the intentional Git-only skip, loader, and typecheck each).
- Package/mirror and registry verification passed. Strict installs reject 0.79.10, excluded 0.85.0, and 0.86.0; isolated forced installs emit peer warnings for each.
- Independent final review approved code and lock metadata. Ready to push #216 and require fresh GitHub CI before merge; no package release is published by this change.
- Verified published 1.5.2 npm metadata directly: its development Pi endpoint was 0.84.2, so README's historical release references retain that endpoint rather than the subsequently tested 0.84.4 checkout.

## Previous progress — PR #215: Vitest 5 migration

**Active branch:** `dependabot/npm_and_yarn/vitest-d440b5915d`

- Reviewed all three dependency PRs; merged the validated Node typings update #217 and incorporated current main.
- Independent pre-implementation review confirmed the two removed `describe.sequential` calls are the required Vitest 5 migration.
- Migrated catalog lifecycle and ownership-race suites to explicit `{ concurrent: false }`; retained all coverage floors and paired Vitest/coverage versions.
- Validation passed under Linux Node 24.19.0 / npm 11.6.2: all 750 tests, real loader, typecheck, coverage floors, and compatibility/package/mirror checks. Both clean packed Pi 0.80.1 and 0.84.4 boundaries passed (749 tests plus the intentional Git-only skip, loader, and typecheck each).
- Independent final review found no actionable issues. Ready to push the migration and require fresh GitHub CI before merging #215.
- Keep #216 held: the Pi 0.85.1 candidate fails two host-catalog assertions and typecheck after upstream removed `grok-build-0.1`. Its loader passes, but exact Pi 0.85.0 fails the loader with missing `@earendil-works/pi-server`; widening support requires an explicit exclusion as well as test/policy/docs updates. No compatibility policy change in this PR.

## Previous progress — Issue #213: empty CSV current row

**Active branch:** `fix/xai-usage-csv-empty-row`

- Ran the requested fetch/checkout/fast-forward/new-branch sequence, then read issue #213 and `extensions/xai/usage.ts`.
- Reproduced seven failures with `npm run test:unit -- tests/usage/csv.test.ts tests/usage/csv-command.test.ts`: the renderer unconditionally inserted a current row even when every data cell was absent.
- Current rows now require at least one nonblank allowlisted data cell. Zero/false remain valid; empty snapshots are header-only, and history-only snapshots retain their history without a fabricated current row.
- All 79 focused usage tests pass, including header-only command output, privacy bounds, history-only export, and individually populated zero/false/metadata fields.
- Updated README and changelog: header-only empty exports, optional current rows, and history-only `total_used_cents`; no inferred current totals or transport changes.
- Validation passed: `npm test` (750 tests plus loader), `npm run typecheck`, `npm run test:coverage` (all floors met), primary LSP diagnostics, session diagnostics, and `git diff --check`.
- Exact packed Pi 0.80.1 and 0.84.4 boundaries passed: each ran 749 tests (one Git-only test intentionally skipped), loader smoke, and typecheck.
- Fix complete. User requested commit, PR merge after checks, and synchronization of local `main`. `IDEA.md` remains untouched and untracked.

## Previous CSV export progress

**Branch:** `feature/xai-usage-csv-export`

- Read AGENTS.md, provider entrypoint, usage implementation/tests, setup, README, and Pi command docs.
- Keep `/xai-usage csv` explicit: reuse the bounded identity-first lookup and display copyable CSV without automatic file writes, cached snapshots, or status opt-in.
- Export only allowlisted normalized current/history fields; cents remain numeric, missing values stay blank, and spreadsheet formulas are neutralized.
- Preserve existing cancellation/reset guards, OAuth-only authentication, redacted errors, and off-by-default status.
- Implemented allowlisted CSV renderer and `/xai-usage csv`; documented the schema, copy/save workflow, cents, blanks, and formula protection in README.md.
- Focused validation: all 66 usage tests pass, including CSV schema/escaping/privacy, both OAuth providers, identity-first transport, error redaction, API-key rejection, invalid arguments, cancellation, reset, and supersession.
- Full gates passed: `npm test` (731 tests plus loader), `npm run typecheck`, `npm run test:coverage` (all floors met), and `npm run compatibility:check` (policy/registry/pack/unsupported peers/mirror). Primary LSP diagnostics: no findings in four changed TypeScript files.
- Added command guidance to AGENTS.md and an Unreleased changelog entry.
- Exact clean packed boundaries passed at Pi 0.80.1 and 0.84.4: each ran 730 tests (one Git-only pack test intentionally skipped), loader smoke, and typecheck.
- Final diff review: scoped changes only; `git diff --check` passed. Session diagnostics contain no blocking errors; existing README/AGENTS code-fence warnings are unchanged.
- Implementation and validation complete; no live authenticated request performed.
- Delivery: commit the scoped CSV changes on `feature/xai-usage-csv-export`, push, and open a PR for review. Do not merge.
- Leave the pre-existing untracked `IDEA.md` untouched; no whole-file reformatting.

## Previous release progress

### Execution Progress — v1.5.2 release

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
