# Codex full-branch review — Pi 1.0 phase

Range reviewed: `feature/module-refactor...HEAD` (`c36a04c3eaf7d381ae7ee1ddf9c9d10bcca56556...eca65b5f22677f21ddffbf74251cd7406aa2fe9b`).

## Spec

### [MAJOR] Hybrid raw `Context` drops shorthand on Pi 0.86+

- Where: `extensions/xai/responses-delegate.ts:29-34`; the regression is codified as expected passthrough in `tests/responses/transcript-context.test.ts:84-87` (commit `fdad7fd`).
- Evidence: Pi 1.0's public `Context` accepts `systemPrompt`, `messages`, and `tools`, and documents the first and third as shorthand that `normalizeContext()` folds into a system message. The `startsWithSystem` branch nevertheless returns a context containing both representations unchanged. Pi 0.86+ delegates read prompt and tool state only from `messages`, so the shorthand fields vanish; Pi 0.80–0.85 delegates read those shorthand fields and ignore the system message, so the same valid shape changes behavior across the supported range. A Pi 1.0 runtime probe returned `{"adapterReturnedSameObject":true,"adaptedMessageCount":2,"adaptedFirstContent":"leading","normalizedMessageCount":3,"normalizedFirstContent":"shorthand","normalizedFirstTools":["demo"]}`. This also makes the blanket direct-context claim in `CHANGELOG.md:15` false for the hybrid case.
- Why it matters: a direct caller that supplies a leading system message plus a new shorthand prompt or tool set silently loses the new prompt/tools on Pi 0.86+, potentially sending a request with stale instructions and no declared tools. Pi's host-normalized provider path is unaffected because it supplies `{ messages }` only.
- Suggested fix: define one cross-version precedence rule for the two representations. To preserve the legacy delegate semantics, the new-Pi path can normalize the shorthand while replacing/skipping the pre-existing leading system message; alternatively reject conflicting hybrid input explicitly instead of silently dropping fields. Add old/new end-to-end payload coverage for both the prompt and tools.

### [MINOR] Reasoning comparison table contradicts C2 and the widened Pi range

- Where: `README.md:429-430` (commit `eca65b5`).
- Evidence: the table says Grok 4.3 exposes `minimal` on both providers and calls the paths identical, while `extensions/xai/models.ts:98-108` now explicitly denies `minimal` for `xai-auth`; only older built-in catalogs without an explicit map may still expose it. The next row says built-in `grok-build-0.1` is available, although Pi removed it in 0.85 and the branch now supports through 1.0.0.
- Why it matters: users on the newly supported versions receive incorrect guidance about selectable thinking levels and built-in model availability.
- Suggested fix: describe built-in Grok 4.3 as version-dependent, list `xai-auth` as `off` / `low` / `medium` / `high`, and say `grok-build-0.1` is present only on the older supported Pi lines.

### [MINOR] Updating instructions still publish the old peer policy

- Where: `README.md:816` (commit `eca65b5`).
- Evidence: this section still says version 1.5.1 requires `>=0.80.1 <0.85.0` and was validated at 0.80.1/0.84.2. The manifest, policy, lockfile, compatibility gate, and README's other compatibility sections now say `>=0.80.1 <1.1.0` with exact boundaries 0.80.1/1.0.0.
- Why it matters: the same README gives mutually exclusive install requirements and tells users the Pi 1.0 combination is unsupported immediately after this phase adds support.
- Suggested fix: update the release-specific paragraph to the widened range and 1.0.0 upper test boundary, or make it clearly historical if it is intended to describe only the already-published artifact.

### [NIT] Planned Grok 4.7 coverage has not landed

- Where: `tests/catalog/reasoning-parity.test.ts:52-55` (commit `aadc442`).
- Evidence: `.scaffold/pi10/plan.md:18-21` requires a conditional Grok 4.7 assertion, but the test deliberately asserts nothing about 4.7. `.scaffold/pi10/review-pi.md:217` accepts a better authenticated `/models-v2` normalization assertion as a post-review follow-up, but that coverage is not in the reviewed tree.
- Why it matters: drift in the entitlement-controlled 4.7 normalization path is currently invisible to the parity suite.
- Suggested fix: land the accepted authenticated-catalog test and assert that the advertised Responses model preserves exactly the catalog-provided levels.

## Standards

No additional documented-standard, security, or baseline-smell findings in the reviewed diff.

## Commands

- `npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent --depth=0` — PASS; both resolve exactly `1.0.0`, so `npm ci` was not needed.
- `npm run typecheck` — PASS.
- `npm test` — PASS; compatibility policy check, 55 Vitest files / 669 tests, and the real loader smoke all passed.
- `npx madge --circular --extensions ts extensions` — PASS; 53 files processed, no circular dependencies.
- `npm run compatibility:check` — PASS; peer/dev/lock/packed manifest agree on `>=0.80.1 <1.1.0` and exact latest `1.0.0`; both unsupported-peer sentinels and the GitHub mirror check passed.
- `node scripts/run-compatibility-matrix.js 0.80.1` — PASS; clean packed install resolved both Pi peers to exact `0.80.1`, with 668 tests passed / 1 pack-verifier skip, loader smoke, and typecheck.
- `node scripts/run-compatibility-matrix.js 1.0.0` — PASS; clean packed install resolved both Pi peers to exact `1.0.0`, with 668 tests passed / 1 pack-verifier skip, loader smoke, and typecheck.
- `git diff --check feature/module-refactor...HEAD` — PASS.
- Pi 1.0 hybrid-context runtime probe — reproduced the MAJOR exactly; adapter returned the hybrid object unchanged while `normalizeContext()` retained the shorthand prompt and tool in an added system message.

Verdict: FAIL

STATUS: COMPLETE

## Claude resolutions
- [MAJOR] Hybrid raw Context drops shorthand on Pi 0.86+: fixed in 989f217. The rule is now "behave like Pi's public `streamSimple`": normalize whenever shorthand is present, and Pi replays existing system messages together with the shorthand. Pi before 0.86 is unchanged (no system role there). An end-to-end hybrid test now passes on the 0.80.1 and 1.0.0 boundaries.
- [MINOR] README reasoning table: fixed in 4c00f1d (version-dependent built-in 4.3, xai-auth off/low/medium/high, grok-build-0.1 only before 0.85). I also corrected a pre-existing "clamps down" claim: Pi clamps upward first.
- [MINOR] Updating instructions: fixed in 4c00f1d. The paragraph now marks 1.5.1's range as the published release's and states the next release's range.
- [NIT] grok-4.7 coverage: fixed in 4c00f1d (authenticated-catalog test).
- Gates after the fixes: typecheck, `npm test` 671/671 + loader, `compatibility:check`, boundaries 0.80.1 and 1.0.0 (670 + 1 skipped each). Live Pi 1.0.0 smoke: see `.scaffold/pi10/smoke.md`.

## Re-review

Range re-reviewed: `git diff eca65b5..4c00f1d` (`989f217`, `4c00f1d`).

### Standards

No findings. The delta introduces no documented-standard or security regressions. The repeated local `lookup_order` test fixture is a possible small Duplicated Code smell, but keeping the two scenarios explicit is reasonable and does not warrant a finding.

### Spec

No findings. All four original findings are resolved:

- `toXaiDelegateContext` now calls Pi 1.0's `normalizeContext` whenever shorthand is present, including hybrid contexts. The new integration test requires the shorthand prompt and tool on every supported Pi and the prior system message on Pi 0.86+.
- `README.md:429-432` now describes version-dependent built-in Grok 4.3 levels, the exact `xai-auth` levels, pre-0.85 `grok-build-0.1` availability, and Pi's upward-first clamp behavior.
- `README.md:816` now distinguishes the published 1.5.1 range from the next release's widened range and exact boundaries.
- `tests/catalog/reasoning-parity.test.ts:217-234` now verifies that an authenticated Grok 4.7 Responses entry advertises exactly its catalog-provided efforts and has no known-metadata fallback.

### Verification

- `git diff --check eca65b5..4c00f1d` — PASS.
- `npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent --depth=0` — PASS; both resolve exactly `1.0.0`.
- Pi 1.0 hybrid runtime probe — PASS: `{"adapterReturnedSameObject":false,"adaptedMessageCount":3,"firstContent":"shorthand","firstTools":["demo"],"secondContent":"leading"}`. This is Pi's public `normalizeContext` result: shorthand prompt/tools lead, and the existing system message remains for transcript replay.
- `npm run test:unit -- tests/responses/transcript-context.test.ts tests/catalog/reasoning-parity.test.ts` — PASS; 2 files, 17 tests.
- `npm run typecheck` — PASS.

Verdict: PASS

STATUS: COMPLETE
