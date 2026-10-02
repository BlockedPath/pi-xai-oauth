# Multi-agent refactor protocol — `feature/module-refactor`

Four agents share one herdr workspace (`wK`, tab `wK:t1`). Pane ids can compact if a pane
closes — re-check with `herdr pane list` and identify panes by their `agent` field.

| Pane | Agent | Role | May edit |
|---|---|---|---|
| `wK:p4` | Claude | Orchestrator, planner, **sole code writer**, final reviewer | everything on the branch |
| `wK:p5` | Grok | Advisor: challenges the plan, answers design questions | `advice-grok.md`, `log.md` only |
| `wK:p1` | Pi | Bug checker: reviews each slice commit as it lands | `review-pi.md`, `log.md` only |
| `wK:p3` | Codex | Big reviewer: full-branch syntax/type/variable/bug sweep | `review-codex.md`, `log.md` only |

Flow: Claude plans → Grok advises → Claude implements slice-by-slice (one commit per slice)
→ Pi reviews each commit while Claude continues → Codex reviews the whole branch → Claude
resolves findings and does the final review. Only Claude edits code, commits, or touches git
state in the main checkout. Nobody pushes.

## Files (all in `.scaffold/refactor/`)

- `PROTOCOL.md` — this file.
- `survey.md` — evidence-backed module survey (file:line citations; line numbers are from `main` at f312a4d).
- `plan.md` — the refactor plan. Claude owns it.
- `advice-grok.md`, `review-pi.md`, `review-codex.md` — each agent's output. Append; never rewrite another agent's text.
- `log.md` — append-only message log. Every message between agents gets one line here:
  `- <ISO time> <from>→<to>: <message>` (get the time with `date -Is`).

## Messaging other agents (herdr CLI)

1. Write the substance into your own file first. Messages are one-line pointers, not content.
2. Append the message to `log.md`.
3. Check the target is free: `herdr pane list` → target pane's `agent_status` must be `idle` or `done`.
   If the target is `working`/`blocked`, do not type into its pane — leave it in `log.md`; Claude relays.
   Exception: messages to Claude (`wK:p4`) are always safe; Claude queues them.
4. Send one line, plain ASCII, no newlines, no backticks or `$`:
   `herdr pane run wK:p4 "[grok->claude] advice ready in .scaffold/refactor/advice-grok.md"`
5. When you finish an assigned task, always ping Claude (`wK:p4`) with the file to read.

If `herdr` fails with `Operation not permitted`, it is a sandbox/socket restriction — retry with
escalated permissions, and if that is impossible just write the file + `log.md`; Claude polls.

## Finding format (reviews and advice)

```
### [BLOCKER|MAJOR|MINOR|NIT] short title
- Where: path/to/file.ts:123 (commit <sha> if applicable)
- Evidence: what the code does, quoted or described precisely
- Why it matters: concrete failure scenario (inputs/state -> wrong result)
- Suggested fix: ...
```

Claude answers each finding inline below it with `- Resolution: fixed in <sha> | rejected because ... | deferred`.

## Ground rules for this refactor

- Behaviour-preserving. Moved code is moved verbatim unless a slice says otherwise; error classes,
  error message text, header contracts, bounds, timeouts and redaction stay identical.
- Never add an `index.ts` under `extensions/` or `extensions/xai/` (pi would load it as an extension).
- `extensions/xai-oauth.ts` and `extensions/xai/usage.ts` keep their paths (loader smoke + pack check).
- Module-level singleton state (runtime models, catalog write queue, redirect guard, register-once
  guards) must keep exactly one owning module.
- Keep each moved block's import specifier style (`node:fs/promises` vs `fs/promises`): tests mock by specifier.
- Never log, print or paste tokens, codes, credentials, `/user` identity or raw authenticated bodies.
- Gates per slice: `npm run typecheck` + `npm test`. Exact Pi boundaries run once on the final tree.
