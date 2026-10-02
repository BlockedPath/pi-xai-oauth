# Refactor plan — module boundaries (`feature/module-refactor`)

Owner: Claude (`wK:p4`). Status: **COMPLETE — v2 executed** (see `advice-grok.md` → Claude resolutions).

Progress: S1 46911c9 ✅ Pi PASS · S2 7fb7abf ✅ Pi PASS · S4 4c4702a ✅ Pi PASS w/ nit (fixed in plan) · S5 25202fb ✅ Pi PASS · S6 db07d7c ✅ Pi PASS · S3 CUT · S7 74cea95 ✅ Pi PASS · S8 5e3645f ✅ Pi PASS · S9 616aa78 ✅ Pi PASS · S10 9515851 ✅ Pi PASS w/ nit (fixed) · Codex branch review ✅ PASS · Claude final ✅ PASS.

## Goal

Make the `extensions/xai/` modules cohesive and cheaper to change, **without changing behaviour**:
split the oversized multi-concern files along their natural seams, replace hand-copied
transport/validation plumbing with the shared primitives, and cut import edges that drag heavy
modules (callback HTTP server, vision routing) into code that does not need them.

Evidence for every item: `survey.md`.

## Invariants (every slice)

- Behaviour-preserving: identical exports' behaviour, error classes, error message text, header
  contracts, bounds, timeouts, redaction, tool/command/provider names, registration order.
- Code moves are verbatim; a slice that changes logic (dedupe) says so and dedupes only copies
  proven semantically identical. Near-duplicates with different semantics stay separate.
- Tests: update imports to the new home of a moved symbol instead of leaving pass-through
  re-exports — except where a test `await import`s a module after `vi.mock` (keep the symbol there).
- No `index.ts` under `extensions/` or `extensions/xai/`; `xai-oauth.ts`, `usage.ts`, the grep
  worker `.mjs` + its loader, and `constants.ts`'s `../../package.json` import keep working paths.
- Singleton module state keeps exactly one owner module.
- Keep `node:`-prefix style of each moved import (tests mock by specifier).
- No new import cycles (check: `npx madge --circular --extensions ts extensions` if available, else grep).
- Gate before each commit: `npm run typecheck` and `npm test`. Final tree also runs
  `npm run compatibility:check` and `npm run compatibility:boundaries`.

## Slices (one commit each, in order)

### S1 — Import-graph fixes and trivial dedupes (low risk)
- Move `XAI_VISION_ROUTING_NAME` from `vision-routing.ts` to `constants.ts`; `tools/commands.ts`
  keeps only an `import type` from `vision-routing.ts` (so it no longer loads vision routing at runtime).
- `vision-routing.ts:94` literal `"xai-auth"` → `XAI_PROVIDER_ID` (same value).
- Drop the `models.ts` → `wire.ts` pass-through re-export; point `responses.ts` (if it uses it),
  `tests/provider/models.test.ts`, `tests/responses/routing.test.ts` at `wire.ts`.
- `oauth.ts` private `messageFromError` → import the identical one from `text.ts`.

### S2 — Shared validation primitives
- New `extensions/xai/validate.ts` for byte-identical small validators (object/record check,
  `positiveInteger`, control-character test) currently copied across `catalog.ts`, `usage.ts`,
  `device-auth.ts`, `oidc.ts`. Only identical copies move; `oidc.ts` uses `hasJsonContentType`
  from `bounded-body.ts` if identical.

### S3 — Shared transport primitives — CUT (Claude + Grok A1 agree)
- Rationale: the five fetch catches are per-route error policy, not duplicated logic; `composeTimeoutSignal`
  and `readBoundedResponseText` are already the shared primitives at the right depth. `fetchWithDeadline`
  would be a shallow helper (more settings than lines saved; every caller still disposes, bounds the body,
  and maps reasons). `readBoundedJsonObject` would move video's `JSON.parse` inside the guarded read and
  turn "abort lands on malformed JSON" into "cancelled". A shared transient-status predicate would couple
  two sites with one expression and invite misuse in the device poll (no 425 there).

### S4 — Split `oauth.ts` (done: oauth-token.ts + oauth-browser.ts)
- `oauth-token.ts`: token exchange, refresh, `ensureFreshXaiCredentials`, `credentialsFromTokenPayload`.
- `oauth-browser.ts` (renamed from oauth-callback.ts: it also owns the authorize URL): PKCE pair, callback server, authorize URL, callback/paste parsing.
- `oauth.ts` keeps login-method selection and the provider factory.
- `auth.ts` imports refresh from `oauth-token.ts` → tools/usage no longer load the callback server or device auth.
  (`oauth-token.ts` still imports `oidc.ts` for the refresh discovery fallback — OIDC unloading is a non-goal.)

### S5 — Split `tools/grok-native.ts`
- `tools/grok-workspace-fs.ts` (containment, workspace paths, bounded no-follow read),
  `tools/grok-grep.ts` (glob, safe regex, walker, worker loader — `.mjs` stays beside it),
  `tools/grok-search-replace.ts` (CRLF/BOM exact replace).
- `grok-native.ts` keeps schemas, executors, registration, `syncGrokNativeToolsForModel`, `web_search`.

### S6 — Split `responses.ts` (done: db07d7c)
- `redirect-guard.ts` (sole owner of the global-fetch guard state), `assistant-stream.ts` (forwarding stream,
  stream error message), `responses-delegate.ts` (delegate identity mapping both ways + rejected-reasoning repair),
  `responses-request.ts` (`postXaiJson`, `createXaiResponse`, payload model pin, runtime-model assertion).
- `responses.ts` keeps `streamSimpleXaiResponses` and `normalizeXaiStreamEvent`.
- Tools import `responses-request.ts` directly; `XAI_VISION_DESCRIPTION_ERROR` moved to `constants.ts`.

### S7 — Split `catalog.ts` (done)
- `catalog-normalize.ts` (`/models-v2` normalization + `XaiCatalogValidationError`),
  `catalog-cache.ts` (path, read/validate record, atomic write, write queue, rollback, tombstone — keeps `fs/promises` specifier).
- `XaiCatalogValidationError` lives in `catalog-normalize.ts`; `XaiCatalogCancelledError` and the single
  `cacheWriteQueues` map live in `catalog-cache.ts` (avoids a catalog ↔ cache cycle).
- `catalog.ts` keeps fetch + selection policy and still exports `selectXaiModelCatalog`/`fetchXaiModelCatalog`
  (`tests/catalog/cache-write-failure.test.ts` mocks `fs/promises` then `await import`s it).

### S8 — Split `usage.ts` (done)
- `usage-parse.ts` (parse/validate, `XaiUsageError`, types), `usage-render.ts` (render + status text).
- `usage.ts` keeps transport, `/xai-usage` command and status lifecycle.

### S9 — Split `payload.ts` (done)
- `payload-tool-names.ts` (Grok-native tool-name exposure/internalization/routes),
  `payload-images.ts` (image-part normalization, detection, consumed-image omission, placeholder).
- `payload.ts` keeps canonicalization, OAuth policy, rewrite and imports the two new modules; they must not import `payload.ts`.

### S10 — Docs and state (done)
- `AGENTS.md` file map + core-flow line, `README.md` project tree, `compatibility/grok-build-wire-protocol.md` module paths (only if a cited file moved),
  `.scaffold/progress.md`.

## Deferred (not in this branch unless Grok makes a strong case)

- Table-driven `defineXaiResponsesTool` for `tools/custom-tools.ts` (error-text/order risk).
- Moving `web_search` out of `grok-native.ts` (registration order / active-tool sync).
- Path-containment and no-follow-read dedupe across `grok-native` and `media/` (one-shot fs hooks in `tests/media/path-races.test.ts`).
- Entrypoint duplicate "model no longer entitled" blocks, bearer extraction, fallback selection.
- `commands.ts` indentation normalization.
- Bounding unbounded `response.json()` in `oidc.ts`, `oauth.ts`, `responses.ts` (behaviour change).

## Review flow

- After S-n is committed, Pi reviews that commit (`review-pi.md`) while Claude starts S-n+1.
- After S10, Codex reviews `git diff main...HEAD` (`review-codex.md`).
- Claude resolves every finding, re-runs all gates, writes `final-claude.md`.
