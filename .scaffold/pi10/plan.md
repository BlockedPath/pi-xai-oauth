# Plan — Pi 1.0 compatibility (`feature/pi-1.0-compat`, stacked on PR #229)

Owner: Claude. Inputs: `matrix.md`, `docs-notes.md`, `research-grok.md`.
Decision: **keep minimum 0.80.1**. New peers `>=0.80.1 <1.1.0`, latest tested `1.0.0`. This is non-breaking: no current user loses support.

Every commit: `npm run typecheck` + `npm test` on the dev-dependency Pi. After C3 that is 1.0.0.

## C1 — Transcript-context adapter (fixes the 0.86+ break)
- `responses.ts`: `toDelegateContext()`. Normalize via a feature-detected `normalizeContext` (from `@earendil-works/pi-ai`,
  present from 0.86.0) only when the context has `systemPrompt`/`tools` and no leading system message. Otherwise pass it through.
  Type the result as `Parameters<typeof streamSimpleOpenAIResponses>[1]`, which is `Context` on ≤0.85 and `TranscriptContext` on ≥0.86.
- Regression test: a raw `Context` with `systemPrompt` + `tools` sent through `streamSimpleXaiResponses` must reach xAI with
  `instructions` + tools. This passes on 0.84.2 and must pass on 1.0.0 (verified after C3).

## C2 — grok-4.3 levels + version-tolerant parity tests
- `models.ts` grok-4.3: `minimal: null` (xAI set `off, low, medium, high`). A saved `minimal` clamps to `low`, the same wire value as before.
  Keep the grok-4.5/4.6 `minimal → low` alias. `catalog-normalize.ts` already aliases only 4.5/4.6.
- `tests/catalog/reasoning-parity.test.ts`:
  - built-in `grok-build-0.1` becomes optional, and we still assert xai-auth never advertises it;
  - `grok-4.7` is asserted only when the installed catalog has it;
  - grok-4.3 is compared to the xAI set. A built-in without an explicit map (≤0.84.2) may additionally list `minimal` (recorded gap).

## C3 — Policy + dependencies + docs
- `compatibility/pi-versions.json`: `peerRange ">=0.80.1 <1.1.0"`, `latest "1.0.0"`, `unsupported.upper "1.1.0"`.
- `package.json`: peers = range; devDependencies exact `1.0.0`; refresh `package-lock.json`.
- README compatibility paragraphs; AGENTS.md if it states the range; CHANGELOG `Unreleased` (if the repo keeps one).
- Gates: `npm test`, `npm run typecheck`, `npm run compatibility:check`, `npm run compatibility:boundaries` (0.80.1 + 1.0.0),
  plus packed candidates at 0.86.0 (transcript break) and 0.99.2.

## C4 — Live smoke on the user's Pi 1.0.0 (herdr pane)
- Load this worktree's extension in Pi 1.0.0 with existing `xai-auth` credentials: one plain turn, one tool turn,
  a same-model continue, and a model switch. Never print credentials.

## Deferred / out of scope
- Known metadata for `grok-4.7`; it is still advertised only when `/models-v2` lists it.
- Opting xai-auth models into `compat.supportsMidConvoSystemMessages` (needs xAI verification).
- 0.99 tool `exposure`/`outputSchema`, image `ModelRuntime`, Pi Durable.

## Review flow
Pi/muse reviews each commit, then delegates the full-branch review to Codex. Claude does the final review, then the live smoke.
