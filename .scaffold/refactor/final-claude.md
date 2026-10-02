# Claude final review — `feature/module-refactor` @ ebab870

Verdict: **PASS** — ready for a PR (not pushed; awaiting the user's go-ahead).

## Independent checks (beyond Pi's per-commit and Codex's full-branch reviews)

- **Line-multiset diff of all `extensions/**` code, main vs HEAD** (imports, blank lines and `export `
  prefixes ignored). Every removed or added line falls into one of these groups:
  - deleted duplicate validators (`objectValue`, `isRecord`, `positiveInteger`, `messageFromError` copies),
  - the dropped `models.ts` → `wire.ts` re-export,
  - inline control-character regexes → `hasControlCharacter`,
  - `"xai-auth"` → `XAI_PROVIDER_ID`,
  - the grep/text byte-ceiling derivation flip (both still `5_000_000`),
  - the `readCache` model-list checks moved verbatim into `validateCachedXaiCatalogModels`,
  - new JSDoc on newly exported symbols.
  No error string, header, bound, timeout, redaction or control-flow line changed anywhere else.
- **Tests:** 12 files changed, and every change is an import path pointing at the symbol's new home.
- **Gates on the final tree:** `npm run typecheck` ✅ · `npm test` (54 files / 664 tests + real loader) ✅ ·
  `madge --circular` ✅ · `git diff --check` ✅ · exact packed boundaries Pi 0.80.1 ✅ and 0.84.2 ✅
  (663 + 1 skipped by design, loader ok, typecheck ok).
- **Out of scope / pre-existing:** `npm run compatibility:check` fails identically on `main`
  (`@earendil-works/pi-ai` 0.84.4 > policy latest 0.84.2; needs a deliberate compatibility review).
  `noUnusedParameters` hit in untouched `tests/videos/image-to-video-errors.test.ts:234`.

## Outcome

11 commits, 47 files. **16 new modules**: 15 split out of six multi-concern files, plus `validate.ts`.
- `oauth`: token, browser
- `tools/grok-native`: workspace-fs, grep, search-replace
- `responses`: request, delegate, assistant-stream, redirect-guard
- `catalog`: normalize, cache
- `usage`: parse, render
- `payload`: images, tool-names

The largest *split* file went from 1128 lines to 468 (`tools/grok-native.ts`). The largest file overall is still
`tools/custom-tools.ts` at 639 lines, because its split was deferred.
(Correction: an earlier version of this file said "22 new modules" and "largest file 468"; both were wrong.)

Runtime import graphs, measured with type-only imports removed:
- `tools/commands.ts` loads 4 modules, down from 17, with no vision routing, payload or images.
- The tool bundle no longer loads `oauth.ts`, `device-auth.ts`, the callback server, `responses.ts` (the OpenAI delegate) or vision routing.
- `auth.ts` and `usage.ts` load only `oidc.ts` among the OAuth modules (the documented refresh fallback).

## Review chain

Grok advised plan v1 and agreed with the S3 cut (A1). Pi reviewed all 9 slice commits plus docs: PASS ×8, PASS WITH NITS ×2, both nits fixed.
Pi delegated the full-branch review to Codex, which returned PASS with no findings. Claude's final review: PASS.

## Second review pass (user-requested), ebab870

Checks the first pass could not cover, because the line-multiset diff ignores imports, comments and packaging:
- **Runtime import graphs (main vs HEAD):** these confirm the S1, S4 and S6 commit-message claims. `madge` had over-reported because it counts `import type` edges.
- **No accidental browser-global capture:** `tsc --lib es2022` (no DOM) reports zero errors in `extensions/` on both main and HEAD.
- **Comments:** the remaining "below" references (`oauth.ts`, `responses.ts`) still point within the same function.
- **Exports:** no new dead exports. The four exports with no other importer are public-signature types or were already exported on main.
- **Packaging:** `.scaffold/` is in `.npmignore`, so the committed refactor notes do not ship.
- **Fixed in ebab870:**
  - Two exported `throwIfAborted` functions with different errors (`abort.ts` and `grok-workspace-fs.ts`): the Grok one is renamed `throwIfOperationAborted`.
  - JSDoc that overstated behaviour (`streamErrorMessage` "safe error text", `objectValue` "plain record").
  - JSDoc that omitted behaviour (`readCache` chmod side effect, `normalizeXaiResponsesInput` scope, the non-object payload rejection by the model-pin error and function).
- Gates after the fixes: typecheck ✅, `npm test` 664/664 + loader ✅.

## Pi 1.0.0 (user report, verified)

The installed `pi` CLI is 1.0.0, and npm `latest` for both `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` is 1.0.0.
The package's peers are `>=0.80.1 <0.85.0` (policy latest 0.84.2), so Pi 0.85 through 1.0.0 are outside the declared range,
on main as well as on this branch. Candidate evaluation: see below.

### Pi 1.0.0 candidate evaluation (`run-compatibility-matrix.js 1.0.0 --candidate`)

- Strict peer install of the packed package against Pi 1.0.0 succeeds.
- `npm test` on **main and on this branch: identical**. 660 pass, 1 skipped (packed mode), 3 fail, all in
  `tests/catalog/reasoning-parity.test.ts`:
  - Pi 1.0 no longer ships the built-in `grok-build-0.1`; the inventory test and the API-key-only exclusion test both fail on that precondition.
  - Pi computes our `grok-4.3` levels as `off, minimal, low, medium, high`, while its built-in model says `off, low, medium, high`.
    This is likely a change in how Pi 1.0 interprets `thinkingLevelMap`, and may be user-visible.
- Real Pi loader smoke on 1.0.0: **ok**.
- `npm run typecheck` on 1.0.0 fails:
  - `responses.ts:257`: Pi 1.0's OpenAI Responses delegate requires a branded `TranscriptContext`, not a plain `Context`.
    This code moved verbatim from main, so main is inferred to have the same error (not run, because main's candidate stopped at `npm test`).
  - `reasoning-parity.test.ts:120`: indexes the removed `grok-build-0.1`.
- Conclusion: the refactor is not affected. Pi 1.0 support needs its own branch covering the transcript-context delegate API,
  the reasoning-level map semantics, the parity tests, intermediate-version candidates, the policy/peer range, and a live smoke test.
