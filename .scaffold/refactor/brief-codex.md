# Brief — Codex (big reviewer, pane wK:p3)

You are the **final, thorough reviewer** in a 4-agent refactor. Claude (`wK:p4`) planned and wrote
the code; Grok (`wK:p5`) advised; Pi/muse (`wK:p1`) reviewed each commit and is delegating this
full-branch review to you. Read first:

1. `.scaffold/refactor/PROTOCOL.md` — roles, finding format, messaging.
2. `.scaffold/refactor/plan.md` — what each slice was supposed to do (S3 was deliberately cut).
3. `.scaffold/refactor/review-pi.md` — Pi's per-commit reviews and its **Handoff to Codex** notes.
4. `AGENTS.md` — the repo's hard security/OAuth/catalog rules.

## Scope

Review the whole branch: `git diff main...9515851` (10 commits, `git log --oneline main..9515851`).
It is a **behaviour-preserving module refactor**: large files in `extensions/xai/` were split into
cohesive modules, a few identical helpers were deduplicated, and docs were updated. Review the
**main checkout** (`/home/justin/projects/pi-xai-oauth`); Claude will not edit it while you work.
**Do not edit any file** except `.scaffold/refactor/review-codex.md` and `.scaffold/refactor/log.md`.
Do not commit, stash, reset, or switch branches.

## What to hunt for (be exhaustive; cite file:line for every finding)

- **Syntax / type errors** and anything the TypeScript compiler would not catch: wrong `import type`
  vs value import, missing or extra `export`, re-exports that disappeared, `typeof X` on type-only imports.
- **Misplaced variables and declarations**: module-level constants/state that moved into the wrong
  module, duplicated or split singleton state (catalog `cacheWriteQueues`, redirect-guard
  `guardedRedirectUrls`/`unguardedFetch`/`redirectGuardFetch`, `runtimeModels`, register-once guards),
  constants whose value or initialization order changed (e.g. `MAX_GROK_GREP_FILE_BYTES` now
  derives from `MAX_GROK_NATIVE_TEXT_FILE_BYTES`), shadowed names (two different `throwIfAborted`
  helpers exist: `abort.ts` and `tools/grok-workspace-fs.ts`), unused or dangling imports.
- **Behaviour drift**: every moved block should be verbatim. Use
  `git diff --color-moved=plain --color-moved-ws=allow-indentation-change main...9515851` and
  scrutinize every non-moved line. Error classes and messages, headers, bounds, timeouts, redaction,
  tool/command/provider names, and registration order must be identical. Known intentional non-verbatim
  changes are `readCache` → `validateCachedXaiCatalogModels` in S7, plus new JSDoc and `export` keywords.
- **Module-load side effects / import graph**: no cycles (`npx madge --circular --extensions ts extensions`),
  no new `index.ts` under `extensions/` or `extensions/xai/`, the grep worker `.mjs` still resolves beside
  `tools/grok-grep.ts`, and `extensions/xai/usage.ts` and `extensions/xai-oauth.ts` stay at their paths.
- **Tests**: updated imports point to the module that now owns the symbol; `vi.mock` specifiers
  (`fs/promises` vs `node:fs/promises`) still intercept the moved code; post-mock `await import`s still work.
- **Docs**: the README tree, AGENTS.md file map and core flow, and the wire-protocol re-audit list match the tree.
- **Security rules from AGENTS.md** still hold: no token/code/state logging, pinned endpoints, bounded reads.

## Commands to run (report exact output for any failure)

- `npm run typecheck`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` (report only hits in files this branch touched)
- `npm test` (policy + 664 unit tests + loader smoke). Some suites start a loopback HTTP server and worker
  threads; if your sandbox blocks them (EPERM/EACCES/listen errors), say so explicitly and request
  escalation instead of reporting a code bug.
- `npx madge --circular --extensions ts extensions`
- Known and out of scope: `npm run compatibility:check` fails on `main` too, because `@earendil-works/pi-ai`
  0.84.4 is newer than the policy's latest (0.84.2). Do not report that.

## Output

Write into `.scaffold/refactor/review-codex.md` using the PROTOCOL finding format, ranked most severe
first. Then add a `## Commands` section with each command's result, and finish with
`Verdict: PASS | PASS WITH NITS | FAIL` and the line `STATUS: COMPLETE`.

## When done

1. Append to `log.md`: `- <date -Is> codex->claude: branch review done, <verdict>`.
2. Ping Claude: `herdr pane run wK:p4 "[codex->claude] review done: <verdict>, see review-codex.md"`.
   If herdr is blocked by your sandbox, request escalation; if that is impossible, the file plus log
   is enough, because Claude is watching for `STATUS: COMPLETE`.
3. Optional: if you need a design clarification mid-review, ask Grok (`wK:p5`) or Pi (`wK:p1`) the
   PROTOCOL way: check the target is idle, log the message, and keep it to one line.
