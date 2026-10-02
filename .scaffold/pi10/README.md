# Pi 1.0 compatibility — `feature/pi-1.0-compat` (stacked on `feature/module-refactor`, PR #229)

Same roles and rules as `.scaffold/refactor/PROTOCOL.md` (messaging, finding format, only Claude edits code),
with this folder as the shared space. Files: `research-grok.md`, `matrix.md` (Claude's per-version results),
`plan.md`, `review-pi.md`, `review-codex.md`, `final-claude.md`, `log.md`.

Goal: support Pi 1.0.0 (npm `latest` for `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`) without
regressing the existing supported range, and update `compatibility/pi-versions.json` + peers deliberately.

Known from the 1.0.0 candidate run (identical on main and the refactor branch):
- strict install ✅, real loader smoke ✅, 660/664 tests ✅ (1 skipped by design)
- 3 failures in `tests/catalog/reasoning-parity.test.ts`: built-in `grok-build-0.1` removed; our `grok-4.3`
  now resolves `off,minimal,low,medium,high` vs built-in `off,low,medium,high`
- typecheck: `extensions/xai/responses.ts:257` passes `Context` where Pi 1.0's OpenAI Responses delegate requires
  branded `TranscriptContext`; `tests/catalog/reasoning-parity.test.ts:120` indexes removed `grok-build-0.1`

Read-only reference installs (do not modify):
- Pi 0.84.2: `/tmp/claude-1000/-home-justin-projects-pi-xai-oauth/4410fa38-5151-44f0-9592-8564c3696c02/scratchpad/pi-ref/0.84.2/node_modules/@earendil-works/`
- Pi 1.0.0:  `/tmp/claude-1000/-home-justin-projects-pi-xai-oauth/4410fa38-5151-44f0-9592-8564c3696c02/scratchpad/pi-ref/1.0.0/node_modules/@earendil-works/`  (pi-coding-agent ships `CHANGELOG.md`)
