# Brief — Codex (big reviewer, pane wK:p3) — Pi 1.0 compatibility

You are the **final, thorough reviewer** for the Pi 1.0 compatibility phase. Pi/muse (`wK:p1`) reviewed each
commit and is delegating this full-branch review to you. Read first:

1. `.scaffold/refactor/PROTOCOL.md` — roles, finding format, messaging (outputs now go in `.scaffold/pi10/`).
2. `.scaffold/pi10/README.md`, `plan.md`, `matrix.md`, `docs-notes.md`, `research-grok.md` (with Claude resolutions).
3. `.scaffold/pi10/review-pi.md` — Pi's per-commit reviews and its **Handoff to Codex** notes.
4. `AGENTS.md` — the repo's hard rules (catalog entitlement, OAuth, compatibility policy).

## Scope

`git diff feature/module-refactor...HEAD` on branch `feature/pi-1.0-compat`. The refactor below it is already
reviewed (PR #229). Unlike the refactor, these commits **intentionally change behaviour**:
- C1 and follow-ups: `toXaiDelegateContext` adapts raw `Context` for Pi 0.86+'s `TranscriptContext`.
- C2: Grok 4.3 known metadata denies `minimal`; parity tests tolerate built-in catalog drift.
- C3: policy `>=0.80.1 <1.1.0`, latest `1.0.0`, devDeps and lockfile at 1.0.0, README/CHANGELOG.

Review the **main checkout** and do not edit anything except `.scaffold/pi10/review-codex.md` and `.scaffold/pi10/log.md`.
Read-only Pi reference installs for both ends of the range are listed in `.scaffold/pi10/README.md`.

## What to hunt for (cite file:line for every finding)

- **Correctness on both ends of the range.** On 0.80.1–0.85, the delegate reads `systemPrompt`/`tools` and has no
  `normalizeContext`. On 0.86–1.0.0, the delegate reads only `messages`. Can any input make the system prompt
  or tools vanish, or get duplicated, on either end?
  - Look at `toXaiDelegateContext` edge cases: empty `tools`/`systemPrompt`, a leading system message plus shorthand fields, and `prepareXaiDelegateContext` ordering.
  - Also check whether the namespace import `import * as piAi from "@earendil-works/pi-ai"` loads and behaves under Pi's real extension loader and virtual modules.
- **Thinking levels.**
  - Does the Grok 4.3 change agree with how `getSupportedThinkingLevels`/`clampThinkingLevel` behave?
  - Does authenticated `/models-v2` evidence still win (`catalog-normalize.ts`)?
  - Are the 4.5/4.6 `minimal → low` aliases unchanged?
- **Tests.** Are the version-tolerant parity assertions still strict enough to catch real upstream drift, or did they become vacuous?
- **Policy consistency.**
  - `compatibility/pi-versions.json`, `package.json` peers/devDependencies and the lockfile root must agree (`scripts/verify-compatibility.js`).
  - The CI matrix in `.github/workflows/ci.yml` derives min/latest from the policy.
  - README/CHANGELOG claims must match what was actually tested.
- **Security rules** from AGENTS.md still hold.

## Commands (report exact output for failures)

- `npm ci` first if `node_modules` does not already resolve Pi 1.0.0 (`npm ls @earendil-works/pi-ai`).
  If your sandbox blocks network, say so and request escalation.
- `npm run typecheck`, `npm test`, `npx madge --circular --extensions ts extensions`
- `npm run compatibility:check`. This is now expected to pass, because 1.0.0 is the newest release inside `<1.1.0`.
- Optional, if time allows: `node scripts/run-compatibility-matrix.js 0.80.1` and `node scripts/run-compatibility-matrix.js 1.0.0`.

## Output

Write `.scaffold/pi10/review-codex.md` in PROTOCOL finding format, most severe first, then a `## Commands` section,
`Verdict: PASS | PASS WITH NITS | FAIL` and `STATUS: COMPLETE`. Log the result in `log.md`, then
`herdr pane run wK:p4 "[codex->claude] pi10 review done: <verdict>, see .scaffold/pi10/review-codex.md"`.
