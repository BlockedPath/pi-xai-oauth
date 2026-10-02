# Pi per-commit review — Pi 1.0 phase

<!-- Pi (wK:p1) adds one "## <sha> <commit id>" section per reviewed commit. -->

## fdad7fd C1

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached fdad7fd.
Diff is 3 files: `toXaiDelegateContext` + delegate-context types in `responses-delegate.ts`,
one call-site wrap in `responses.ts`, new `tests/responses/transcript-context.test.ts` (5 tests).

Verification (production fix — correct on both ends):

- Guard logic matches plan C1 and Grok's advice: feature-detected `normalizeContext`, fold only
  when shorthand present and no leading system message, otherwise pass through. Retag-then-adapt
  order preserved (`prepareXaiDelegateContext` first, which spreads shorthand through).
- Verified against the read-only refs: `normalizeContext` absent everywhere in 0.84.2 (rg exit 1)
  and exported from the 1.0.0 pi-ai index (`export * from "./utils/transcript.js"`); 0.84's
  delegate reads `context.systemPrompt` (`openai-responses-shared.js:90`); 1.0's delegate calls
  `resolveTranscript` over `context.messages` only; `StreamFunction`'s context param is `Context`
  on 0.84.2 and `TranscriptContext` on 1.0.0, so the `Parameters<...>[1]` spelling tracks both.
- Pi's `normalizeContext` treats empty `tools`/`systemPrompt` as absent (length checks), so C1's
  presence-check calling it for `tools: []` is harmless (same messages, fresh wrapper, delegate
  reads messages only). The leading-system guard prevents the double-prepend Pi would otherwise
  produce. No new throw surface (`prepareXaiDelegateContext` already maps `messages` first).
- `delegateContext` has a single consumer (the delegate call, `responses.ts:256`); no other module
  references the new symbols. No unused imports, `madge --circular` clean, no `index.ts`, paths
  intact, no `vi.mock` interaction (new test uses a stubbed global fetch, restored in `afterEach`).
- Local gates (dev Pi 0.84.2): typecheck clean; full suite 669/669 (664 + 5 new).
- Pi 1.0.0 candidate matrix (`run-compatibility-matrix.js 1.0.0 --candidate`): production
  TS2741 is FIXED — a manual `tsc --noEmit` in the retained workspace shows only the known
  `reasoning-parity.test.ts:120` TS7053 (C2's fix). The 3 known parity failures are unchanged.
- Plan conformance: matches C1 except cosmetic placement (`toXaiDelegateContext` lives in
  `responses-delegate.ts` next to `prepareXaiDelegateContext` rather than in `responses.ts`,
  Xai-prefixed per repo convention) — sensible, not a finding.

### [MAJOR] New passthrough test fails on Pi 1.0.0: explicit `undefined` triggers the default parameter

- Where: `tests/responses/transcript-context.test.ts:75` vs
  `extensions/xai/responses-delegate.ts:24-27` (commit fdad7fd)
- Evidence: the test calls `toXaiDelegateContext(context, undefined)` expecting the
  no-normalize path, but JS default parameters apply to explicit `undefined`, so `normalize`
  becomes the module-level `piNormalizeContext` — the real `normalizeContext` on Pi 1.0.0.
  The 1.0.0 candidate run fails with Pi prepending `{role: "system", content: "p"}` instead of
  returning `context` (`expected { messages: [...] } to be { systemPrompt: 'p', ... }`). On 0.84.2
  the test passes only because the default itself is `undefined` there. Result: 4 failures on
  1.0.0 instead of the 3 known parity failures, so C1 misses its own acceptance
  ("must pass on 1.0.0") and would break C3's green-matrix gate. Production code is unaffected
  (real callers omit the argument).
- Why it matters: concrete matrix output above — `tests/responses/transcript-context.test.ts`
  (5 tests | 1 failed) on ai=1.0.0/agent=1.0.0.
- Suggested fix: accept an explicit absent marker that does not trigger the default, e.g.
  `normalize: XaiContextNormalizer | null = piNormalizeContext ?? null` (the existing
  `!normalize` check already treats `null` as absent), and pass `null` in the test. A short
  comment noting the `undefined`-triggers-default footgun would prevent recurrence.

### [NIT] Document why the two `as unknown as` casts are safe

- Where: `extensions/xai/responses-delegate.ts:15,28` (commit fdad7fd)
- Evidence: line 15 probes an export missing from older Pi's types; line 28 upcasts `Context`
  to the branded `TranscriptContext` on the deliberate passthrough paths (no-op at runtime).
  Both are correct, but they are the subtlest lines in the commit and carry no rationale.
- Why it matters: a future reader (or strict-cast lint) cannot distinguish these deliberate
  casts from accidental ones; one line each would lock in the reasoning.
- Suggested fix: add `// SAFETY:` comments — line 15: feature probe, `undefined` on Pi < 0.86;
  line 28: brand is type-only, and passthrough happens only on old Pi (delegate reads
  shorthand) or for already-folded transcripts, so the cast is sound.

Verdict: FAIL

- Resolution (fdad7fd MAJOR): already fixed in 822dd51 (queued for you) with exactly your suggested `| null = piNormalizeContext ?? null` design and `null` in the test. C1+C2 then passed the Pi 1.0.0 candidate fully (668 passed + 1 skipped, loader, typecheck).
- Resolution (fdad7fd NIT): fixed in ca656ef (`SAFETY:` comments on both casts).

## 822dd51 C1-fixup

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 822dd51.
Diff is 2 lines of code + 1 JSDoc line: `normalize` param becomes
`XaiContextNormalizer | null = piNormalizeContext ?? null`, test passes `null`.

Verification:

- Fix is exactly the suggested design: explicit `null` does not trigger the default parameter,
  and the existing `!normalize` check treats it as absent, so the no-normalizer path is now
  genuinely injectable on every Pi version. The JSDoc documents `null` as the contract.
- No production behavior change: the sole real caller (`responses.ts`) omits the argument,
  so it gets `piNormalizeContext ?? null` — identical to before on both old Pi (`undefined`
  → `null`, both falsy) and new Pi (real `normalizeContext`).
- Gates in worktree (dev Pi 0.84.2): typecheck clean; `tests/responses` 114/114. Pi 1.0.0
  behavior of this fix is covered by the C2 matrix run below (the `null` test runs there).
- Plan conformance: direct resolution of the fdad7fd MAJOR; nothing else in the diff.

No findings.

Verdict: PASS

## aadc442 C2

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached aadc442.
Diff is 3 files: grok-4.3 `minimal: null` in known metadata, version-tolerant parity tests,
one synced `models.test.ts` expectation.

Verification:

- `minimal: null` denies the level Pi-side (missing-key/`null` rule verified in research) while
  the picker change is exactly scoped to 4.3: 4.5/4.6 keep `minimal: "low"` (models.ts:49,76
  untouched), and `catalog-normalize.ts` aliases `minimal` only for 4.5/4.6 (lines 167-175) —
  logged-in 4.3 catalogs already produced `minimal: null`, so this aligns fallback with
  authenticated behavior as the commit message claims.
- Saved-`minimal` wire value unchanged: Pi clamps denied `minimal` forward to `low`, and
  `payload.ts:114` still rewrites any leftover `minimal` effort to `low` as a backstop.
  `grokSupportsReasoningEffort` still true for 4.3 (low/medium/high map to strings).
  No other extension code keys off 4.3+`minimal` (only unrelated doc word in vision-routing).
- Parity tests: grok-build-0.1 no longer required (fixes the 0.85+ inventory failure and the
  `:120` TS7053) while xai-auth-never-advertises is still asserted; 4.3 asserted against the
  xAI set with `minimal` null, and the built-in expectation branches on map presence instead
  of version-sniffing (correct on every line regardless of when the map appeared).
- `models.test.ts` sync verified: the expanded 4.3 inherits `thinkingLevelMap` from known
  metadata, so the `minimal: null` expectation reflects the merge, not just the edit.
- Gates: local typecheck clean, full suite 669/669; **Pi 1.0.0 candidate matrix fully green**
  (exit 0: 54 files, 668 passed + 1 skipped, loader smoke, typecheck) — the 3 known parity
  failures and the TS7053 are gone, and the C1-fixup `null` test passes there.
- No import/cycle/mock/singleton/path concerns (one-word prod change + test edits).

### [NIT] Plan's conditional grok-4.7 assertion not implemented

- Where: `tests/catalog/reasoning-parity.test.ts:48-56` (commit aadc442) vs plan C2
- Evidence: plan C2 says "`grok-4.7` is asserted only when the installed catalog has it," but
  the inventory test asserts nothing about 4.7 (only a comment explaining neither 4.7 nor
  build-0.1 is asserted). 4.7 was never asserted before either, so this drops planned coverage
  rather than regressing it.
- Why it matters: if a future Pi renames/removes 4.7, no test notices. Minor — the chosen
  shape is robust and the rationale is documented in the comment.
- Suggested fix: either add the conditional 4.7 assertion per plan, or update the plan C2 line
  to match the implemented shape.

Verdict: PASS WITH NITS

## ca656ef C1-NIT-fixup

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached ca656ef.
Diff replaces 1 comment line with 4 comment lines in `responses-delegate.ts`; zero code lines
touched (verified from the full diff).

Verification:

- Both `SAFETY:` comments are accurate: the probe comment matches the verified old-Pi behavior
  (no export, delegate reads shorthand); the cast comment's "only on Pi before 0.86 or for an
  already folded transcript" holds because on new Pi the passthrough paths are exactly the
  nothing-to-fold cases (no shorthand, or leading system already present).
- Gates: typecheck clean; `transcript-context.test.ts` 5/5.
- Plan conformance: direct resolution of the fdad7fd NIT; nothing else in the diff.

No findings.

Verdict: PASS

## eca65b5 C3

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached eca65b5
(own `node_modules`; ran `npm ci` per instructions — dev Pi now exact 1.0.0).
Diff is 5 non-code files: CHANGELOG, README, `pi-versions.json`, `package.json`, lockfile.

Verification:

- `pi-versions.json`: `peerRange >=0.80.1 <1.1.0`, `minimum` kept at 0.80.1, `latest 1.0.0`,
  `unsupported` sentinels 0.79.10/1.1.0 — exactly the plan. `package.json` peers match the
  range; devDeps exact 1.0.0; lockfile pins both Pi packages at 1.0.0 (verified).
- README compatibility paragraphs accurate against the reviewed behavior and the 1.0.0 refs:
  0.86 TranscriptContext handling (passthrough/fold/unchanged per line), 0.85 build-0.1
  removal, 0.87 grok-4.7 addition, boundaries 0.80.1+1.0.0, `<1.1.0` rationale. AGENTS.md states
  no version numbers (rg), so no update needed there per the plan's conditional.
- CHANGELOG entries sit under `## Unreleased` (Added/Fixed/Changed) and describe C1–C3
  faithfully, including the saved-`minimal`-clamps note and the authenticated-evidence-wins rule.
- No code files touched; no import/cycle/mock/singleton/path concerns possible.
- Plan conformance: matches C3 exactly.
- Gates in worktree: `npm test` green on dev Pi 1.0.0 (policy + 55 files / 669 tests + loader
  smoke); `typecheck` clean; `compatibility:check` green (manifest, both unsupported-peer
  sentinels, mirror); `compatibility:boundaries` green (**0.80.1 ok**, **1.0.0 ok**);
  packed candidates green at **0.86.0** (transcript-break version) and **0.99.2** (668+1 each).

No findings.

Verdict: PASS

## Handoff to Codex

Pi's per-commit reviews are above: fdad7fd C1 FAIL (MAJOR test bug + NIT, both resolved by
Claude), 822dd51 C1-fixup PASS, aadc442 C2 PASS WITH NITS, ca656ef C1-NIT-fixup PASS,
eca65b5 C3 PASS. Unlike the refactor phase these were behavior fixes, so I verified them
against both ends of the range: read-only 0.84.2/1.0.0 ref installs, local gates on each
commit's dev Pi, the 1.0.0 candidate matrix for C1+C2, and for C3 the full gate set
(`npm test`, typecheck, `compatibility:check`, both exact boundaries, 0.86.0 + 0.99.2
candidates — all green). Riskiest spots for your full-branch sweep (`git diff
feature/module-refactor...HEAD`):

1. C1 adapter guard matrix (`responses-delegate.ts` `toXaiDelegateContext`): the hybrid case
   (leading system message AND shorthand fields) passes through, which preserves status quo
   but means each Pi line's delegate picks a different prompt source. Cannot occur from Pi
   itself (its `normalizeContext` returns `{messages}` only); direct callers only. Confirm you
   agree it needs no handling.
2. C1 `| null` injection contract: explicit `undefined` still triggers the default parameter
   (JS semantics) — only `null` simulates absent. The JSDoc documents it; check no other
   caller/test trips on this.
3. C1 `import * as piAi` namespace import + `Parameters<ReturnType<typeof
   openAIResponsesApi>["streamSimple"]>[1]` type-tracking: verified on 0.84.2/1.0.0 refs and
   by green 0.80.1-boundary typecheck, but it is the subtlest cross-version construct —
   re-verify the 0.80.1 end independently if you can.
4. C2 grok-4.3 `minimal: null`: picker no longer offers it; saved-`minimal` wire value relies
   on Pi's `clampThinkingLevel` (→ `low`) plus our `payload.ts:114` backstop. Confirm no other
   path (vision routing, commands, compat expansion) assumed 4.3+`minimal`.
5. C2 parity-test version tolerance: the built-in-4.3 expectation branches on map presence
   (robust, no version sniffing), but conditional assertions can mask future drift — and
   grok-4.7 is deliberately unasserted (my NIT). Judge whether that coverage gap is acceptable.
6. C3 lockfile refresh (3128 lines) + peer widening to `<1.1.0`: `compatibility:check` passed
   and both exact boundaries are green, but skim for unexpected dependency changes if you have
   a fast way to diff effective trees.

- Resolution (aadc442 NIT, grok-4.7): accepted, in a better form. The test will cover what xai-auth controls: an authenticated `/models-v2` `grok-4.7` entry normalizes to an advertised Responses model with exactly the catalog's levels (we keep no known metadata for 4.7). It lands after Codex's review so the tree stays still during the sweep.
