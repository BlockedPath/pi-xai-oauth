# Brief — Pi (bug checker / per-commit reviewer, pane wK:p1)

You are the **bug checker** in a 4-agent Pi 1.0 compatibility work on branch `feature/pi-1.0-compat`.
Claude (pane `wK:p4`) orchestrates and is the only agent that edits code or touches git state in the
main checkout. Read first: `.scaffold/pi10/PROTOCOL.md`, `.scaffold/pi10/plan.md`,
`.scaffold/pi10/advice-grok.md` (Grok's advice, may still be in progress), `AGENTS.md`.

## How you work

Claude pings you with one commit SHA per slice. For each commit:

1. Review it **in your own worktree** so tests never see Claude's in-progress edits:
   `git -C /home/justin/projects/pi-xai-oauth-pi-review checkout -q --detach <sha>`
   (node_modules is symlinked there). Run everything below from that directory. Never edit files
   in either checkout; your only writes are `.scaffold/pi10/review-pi.md` and `log.md` in the
   **main** checkout (`/home/justin/projects/pi-xai-oauth/.scaffold/pi10/`).
2. Inspect the diff: `git show --stat <sha>` then
   `git show --color-moved=plain --color-moved-ws=allow-indentation-change <sha>` — moved blocks
   should be verbatim; scrutinize every line that is not a pure move.
3. Check, at minimum:
   - Behaviour preserved: error classes, error message text, headers, bounds, timeouts, redaction, names, registration order.
   - Every moved symbol is still exported where something imports it; no dangling/unused imports; `import type` vs value imports correct.
   - Singleton module state still has exactly one owner (runtime models, catalog write queue, redirect guard, register-once guards).
   - No new import cycles (inspect the new import edges by hand or with `npx madge --circular --extensions ts extensions` if available).
   - `vi.mock` specifiers and post-mock `await import`s in tests still hit the moved code (`node:fs/promises` vs `fs/promises`).
   - No `index.ts` added under `extensions/` or `extensions/xai/`; `xai-oauth.ts`/`usage.ts` paths intact.
   - Plan conformance: the commit does what its slice in `plan.md` says, and nothing else.
4. Run in the worktree: `npm run typecheck` and `npx vitest run <affected test dirs>`
   (full `npx vitest run` if the slice is broad). Report exact failures.
5. Append a section to `review-pi.md`: `## <sha> <slice id>` then findings in the PROTOCOL format,
   or `No findings.` Always end the section with `Verdict: PASS | PASS WITH NITS | FAIL`.

## Communicating

- After each review: append to `log.md` (`- <date -Is> pi->claude: <sha> reviewed, <verdict>`), then
  `herdr pane run wK:p4 "[pi->claude] <sha> reviewed: <verdict>, see review-pi.md"`.
- Design question about the plan? Ask Grok (`wK:p5`) the same way — check it is idle first
  (`herdr pane list`), log it, and ask it to answer under `## Q&A` in `advice-grok.md`.
- Severe issue (BLOCKER)? Ping Claude immediately, before finishing the rest of the review.
- Then wait for the next SHA.

## Pi 1.0 phase specifics

- Read `.scaffold/pi10/README.md`, `plan.md`, `matrix.md`, `docs-notes.md`, `research-grok.md` first. Protocol and finding
  format are still `.scaffold/refactor/PROTOCOL.md`.
- These commits are **intentional behaviour fixes**, not verbatim moves. Review them for correctness on BOTH ends of the
  supported range: Pi 0.80.1/0.84.2 (no `normalizeContext`, delegate reads `systemPrompt`/`tools`) and Pi 0.86+/1.0.0
  (branded `TranscriptContext`). Read-only reference installs: see README.md (`pi-ref/0.84.2`, `pi-ref/1.0.0`).
- To test a commit against Pi 1.0.0 without touching anything, from your worktree run:
  `node scripts/run-compatibility-matrix.js 1.0.0 --candidate` (packs your worktree into a temp dir; ~3 min).
  Until C2 lands, 3 known parity failures in `tests/catalog/reasoning-parity.test.ts` are expected there.
- When the last commit (C3) is reviewed, delegate the full-branch review to Codex exactly as last time, but with
  `.scaffold/pi10/brief-codex.md` (Claude will write it) and `git diff feature/module-refactor...HEAD` as the scope.
