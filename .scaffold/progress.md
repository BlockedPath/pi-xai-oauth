# Execution Progress — Module refactor

**Branch:** `feature/module-refactor` (from `main` @ f312a4d)
**Coordination:** `.scaffold/refactor/` (PROTOCOL, survey, plan v2, advice/reviews, message log)
**Agents (herdr workspace wK):** Claude `wK:p4` orchestrator/writer · Grok `wK:p5` advisor ·
Pi/muse `wK:p1` per-commit bug checker → delegates the branch review to Codex `wK:p3` · Claude final review.

## Completed

- [x] Surveyed module boundaries; wrote protocol, survey, plan v1; Grok advised; plan v2 folded in.
- [x] S1 46911c9 import-edge trims (vision-routing constant, provider id, wire re-export, messageFromError) — Pi PASS.
- [x] S2 7fb7abf `validate.ts` for byte-identical validators (OIDC keeps strict content type) — Pi PASS.
- [x] S3 cut — per-route fetch/error policy is not duplicated logic (Claude + Grok A1).
- [x] S4 4c4702a `oauth-token.ts` + `oauth-browser.ts` — Pi PASS w/ plan nit (fixed).
- [x] S5 25202fb `tools/grok-workspace-fs.ts`, `grok-grep.ts`, `grok-search-replace.ts` — Pi PASS.
- [x] S6 db07d7c `redirect-guard.ts`, `assistant-stream.ts`, `responses-delegate.ts`, `responses-request.ts`; vision description error → constants — Pi PASS.
- [x] S7 74cea95 `catalog-normalize.ts`, `catalog-cache.ts` — Pi PASS.
- [x] S8 5e3645f `usage-parse.ts`, `usage-render.ts` — Pi PASS.
- [x] S9 616aa78 `payload-images.ts`, `payload-tool-names.ts` — Pi PASS.
- [x] S10 9515851 README tree, AGENTS.md map/flow, wire-protocol re-audit list.
- [x] Every commit: `npm run typecheck` + `npm test` (54 files / 664 tests + loader smoke) green; madge: no cycles.

- [x] Pi reviewed S10 (PASS WITH NITS, fixed) and delegated the full-branch review to Codex: PASS, no findings.
- [x] Exact packed Pi boundaries 0.80.1 and 0.84.2 pass on the final tree.
- [x] Claude final review PASS (`refactor/final-claude.md`).

## Next

- User decision: push `feature/module-refactor` and open a PR.

## Known / out of scope

- `npm run compatibility:check` fails on `main` too: `@earendil-works/pi-ai` 0.84.4 is newer than the
  policy's latest 0.84.2 and needs a deliberate compatibility review (separate task).
- Deferred: custom-tools table-driven helper, moving `web_search`, path-containment dedupe across
  grok-native/media, entrypoint duplicate blocks, commands.ts indentation, bounding unbounded `response.json()` reads.
