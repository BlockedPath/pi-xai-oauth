# Brief — Grok (advisor/researcher, pane wK:p5) — Pi 1.0 compatibility

Read `.scaffold/pi10/README.md` first (context, reference install paths) and `.scaffold/refactor/PROTOCOL.md`
(messaging + finding format). Read-only: write only `.scaffold/pi10/research-grok.md` and `.scaffold/pi10/log.md`.
Claude is concurrently running per-version candidate tests (0.84.4 … 0.99.2) — do not run npm in the repo.

Research by reading the two reference installs (`.d.ts`, `dist/`, `CHANGELOG.md`, `docs/`) and our code under
`extensions/` and `tests/`. Cite file paths (+ CHANGELOG version headings) for every claim. Answer:

1. **TranscriptContext.** Exact definition and brand; what produces one (factory/converter?); does Pi 1.0's
   `openAIResponsesApi().streamSimple` (`@earendil-works/pi-ai/compat`) behave differently at runtime when given
   a plain `Context` (does it re-derive/validate, or is the brand type-only)? What is the correct adaptation in
   `extensions/xai/responses.ts` (`prepareXaiDelegateContext` → delegate call) that typechecks and is correct on
   BOTH the old minimum (0.80.1 types have no brand) and 1.0.0? Show the TypeScript you recommend.
2. **Thinking levels.** Why does `getSupportedThinkingLevels` now report `minimal` for our `grok-4.3` (see
   `tests/catalog/reasoning-parity.test.ts`, our `thinkingLevelMap` in `extensions/xai/models.ts` /
   `catalog-normalize.ts`)? State the 1.0 rule for missing vs `null` vs string map entries, the 0.84 rule, and the
   map we should emit so supported levels match xAI on both. Is this user-visible (level picker / request payload)?
3. **Built-in xAI model catalog changes** (`@earendil-works/pi-ai/providers/xai.models` or successor): removed /
   added / renamed models (e.g. `grok-build-0.1`), changed metadata, and what our parity tests should assert now.
4. **Extension/AI API changes 0.84.2 → 1.0.0 that touch what we use**, each mapped to our call sites (file:line):
   `registerProvider` + OAuth provider shape (login callbacks, `onSelect`, `onDeviceCode`, `onManualCodeInput`,
   `usesCallbackServer`, `refreshToken`, `getApiKey`), `registerTool` fields, `registerCommand`, events
   (`session_start`, model/session changes), `ctx.ui`, `getActiveTools`/`setActiveTools`, `create*ToolDefinition`
   options (`spawnHook`, `operations`), `getAgentDir`, AuthStorage / model registry / credential APIs used in
   `extensions/xai/auth.ts`, and `SimpleStreamOptions` fields we rely on (`onPayload`, `sessionId`, `maxRetries`,
   `headers`, `apiKey`, `signal`). Flag silent semantic changes, not just type changes.
5. **Timeline.** For each break, which release introduced it (0.84.3 … 1.0.0)?
6. **Recommendation.** New peer range and `minimum` (keep 0.80.1, or raise it?), and anything that must change in
   `compatibility/pi-versions.json`, `package.json` peers/devDeps, `scripts/verify-compatibility.js`, CI, docs.

Keep it under ~1300 words, ranked by risk, PROTOCOL finding format for problems. End with `STATUS: COMPLETE`.
When done: append to `log.md`, then `herdr pane run wK:p4 "[grok->claude] pi10 research ready in .scaffold/pi10/research-grok.md"`.
