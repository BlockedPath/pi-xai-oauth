# Claude final review — `feature/pi-1.0-compat` @ 4c00f1d (stacked on PR #229)

Verdict: **PASS**. Not pushed; awaiting the user's go-ahead.

## What changed (7 commits)
- `toXaiDelegateContext` (`responses-delegate.ts`) adapts contexts for Pi's Responses delegate the way Pi's public
  `streamSimple` does. On Pi 0.86+ (feature-detected `normalizeContext`), a context with shorthand fields is folded
  (including hybrid contexts); Pi's own normalized transcripts pass through. Pi 0.80–0.85 is unchanged. The result is
  typed as the installed delegate's parameter, which fixes TS2741 on 0.86+ while still typechecking on 0.80.1.
- Grok 4.3 known metadata denies `minimal` (xAI efforts are none/low/medium/high; Pi 0.84.4+ agrees); a saved `minimal`
  clamps upward to `low`. Authenticated `/models-v2` evidence still decides. The 4.5/4.6 `minimal → low` aliases are unchanged.
- Parity tests tolerate built-in catalog drift (grok-build-0.1 removed in 0.85, map-less grok-4.3 before 0.84.4); a new
  authenticated grok-4.7 test.
- Policy `>=0.80.1 <1.1.0`, latest 1.0.0; devDependencies and lockfile exactly 1.0.0; README/CHANGELOG.

## Evidence
- Red→green: the raw-Context test failed on the packed Pi 1.0.0 candidate before C1 (instructions undefined) and passes after.
- Gates on the final tree: typecheck; `npm test` 671/671 + loader (dev Pi 1.0.0); `compatibility:check` (fails on main today);
  boundaries 0.80.1 and 1.0.0 (670 + 1 skipped each). Candidates 0.86.0 and 0.99.2 were green at eca65b5, and the delta since is the hybrid fix plus docs/tests.
- Live smoke on the user's Pi 1.0.0 with only this extension loaded (`smoke.md`): login, plain turn, tool turn, same-model continue,
  switch to grok-4.7, grok-4.3 `minimal` clamp. Re-run on the final tree: plain + tool ✅.
- No other `context.messages` readers. Node engines are unchanged (>=22.19.0). The lockfile adds only 4 transitive Pi 1.0 deps at
  top level (+ our existing `protobufjs` hoisted).

## Review chain
Grok researched 0.84.2→1.0.0 (blocker + 2 majors, all addressed; one suggestion declined so authenticated evidence still wins).
Pi reviewed 5 commits (one FAIL already fixed by the queued follow-up; nits fixed) and delegated to Codex.
Codex: FAIL (hybrid context, README ×2, grok-4.7 test). All fixed; re-review PASS.

## Follow-ups (not in this branch)
- Known metadata for `grok-4.7` / `grok-4.7-build-fast` (the user's account is entitled; they currently get conservative
  defaults of 16.4K max output and text-only). Needs verified xAI figures.
- Optional opt-in to `compat.supportsMidConvoSystemMessages` for xai-auth models (needs xAI verification).
