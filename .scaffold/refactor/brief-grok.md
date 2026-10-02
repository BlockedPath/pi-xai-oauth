# Brief — Grok (advisor, pane wK:p5)

You are the **advisor** in a 4-agent refactor of this repo on branch `feature/module-refactor`.
Claude (pane `wK:p4`) orchestrates and is the only agent that edits code. Read first:

1. `.scaffold/refactor/PROTOCOL.md` — roles, files, how to message other agents (herdr CLI).
2. `.scaffold/refactor/survey.md` — evidence-backed module survey.
3. `.scaffold/refactor/plan.md` — Claude's draft plan v1.
4. `AGENTS.md` — repo hard rules (security/OAuth/catalog invariants).

## Task

Stress-test the plan. Read the actual source under `extensions/` and `tests/` to verify claims —
do not trust the survey's line numbers blindly. **Read-only**: do not edit any file except
`.scaffold/refactor/advice-grok.md` and `.scaffold/refactor/log.md`. Do not run git commands that
change state.

Write your advice into `.scaffold/refactor/advice-grok.md` using the finding format in PROTOCOL.md,
covering:

1. **Scope and order** — keep, cut, merge, or reorder slices S1–S10? Anything in "Deferred" that should be in, or vice versa?
2. **Behaviour-preservation hazards per slice** — error class/message text tests assert, module-level
   singleton state (runtime models, catalog write queue, redirect guard / global fetch patch,
   register-once guards), `vi.mock` specifiers and post-mock `await import`s, registration order,
   anything that would silently change semantics when code moves files.
3. **S3 design** — propose the concrete TypeScript signature for `fetchWithDeadline` (and
   `readBoundedJsonObject`) that lets all 5 call sites keep their own error types/messages.
   Check whether the 5 copies are really equivalent and list any that should NOT be merged.
4. **Module naming / placement** — are the proposed new file names and homes right?
5. **Anything missed** — cycles the splits could create, docs/scripts that cite paths, pack/loader checks.

Keep it under ~900 words, ranked most important first. End the file with the line `STATUS: COMPLETE`.

## When done

1. Append to `log.md`: `- <date -Is> grok->claude: advice ready in advice-grok.md`
2. Ping Claude: `herdr pane run wK:p4 "[grok->claude] advice ready in .scaffold/refactor/advice-grok.md"`

Afterwards stay available: Claude, Pi or Codex may ping you with design questions during
implementation. Answer by appending to `advice-grok.md` under a `## Q&A` heading, log it, and ping
the asker back the same way.
