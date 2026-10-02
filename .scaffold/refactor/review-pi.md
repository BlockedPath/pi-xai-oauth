# Pi per-commit review

<!-- Pi (wK:p1) adds one "## <sha> <slice>" section per reviewed commit. -->

## 46911c9 S1

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 46911c9.
Diff is 7 files and implements exactly the four S1 bullets in plan.md, nothing else.

Verification:

- `XAI_VISION_ROUTING_NAME` moved verbatim (`"vision-routing"`) to `constants.ts:117`; sole
  consumer `tools/commands.ts` updated; repo-wide rg shows no remaining importer of it (or of
  anything else) from `vision-routing.ts`'s old export; no test referenced the old location.
- `tools/commands.ts` keeps only `import type { XaiVisionRoutingController }` from
  `vision-routing.ts` — all 5 uses confirmed type-position annotations, so the runtime edge is
  gone and the `import type` is correct. No unused imports left.
- `vision-routing.ts` `"xai-auth"` literal -> `XAI_PROVIDER_ID`, which is `"xai-auth"`
  (`constants.ts:70`); no remaining literal in the file. Behaviour identical.
- `models.ts` -> `wire.ts` pass-through re-export dropped; `responses.ts` already imported
  `xaiProxyRequestHeaders` from `./wire` directly (plan's "if it uses it" correctly needed no
  change); `tests/provider/models.test.ts` and `tests/responses/routing.test.ts` repointed to
  `wire.ts`; repo-wide rg confirms zero remaining imports of the 4 symbols via `models`.
- `oauth.ts` private `messageFromError` replaced with the `text.ts:48` import; old body
  (`error instanceof Error ? error.message : "Unknown error"`) is byte-identical to the new
  one; single import + single use in `oauth.ts`.
- New import edges are acyclic: `text.ts` has zero imports, `constants.ts` imports only
  `package.json`; `npx madge --circular` reports no circular dependencies.
- Mock-safe: neither touched test file uses `vi.mock`/`await import`.
- No `index.ts` added; `xai-oauth.ts`/`usage.ts` paths intact; singleton module state untouched;
  no error class/message/header/bound/timeout/redaction changes.
- Gates in worktree: `npm run typecheck` clean; full `npx vitest run`: 54 files / 664 tests pass.

No findings.

Verdict: PASS

## 7fb7abf S2

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 7fb7abf.
Diff is 5 files and implements exactly the S2 slice in plan.md, nothing else.

Verification:

- All four moved validators are byte-identical to the copies they replace (old bodies visible
  in the diff): `objectValue` (catalog, usage), `positiveInteger` (catalog, device-auth),
  `isRecord` (device-auth, oidc). Runtime behaviour identical.
- `isRecord` predicate-type change is a no-op: device-auth's old `value is JsonRecord` narrows
  identically to the new `value is Record<string, unknown>` because
  `type JsonRecord = Record<string, unknown>` (device-auth.ts:34); `JsonRecord` is still used
  for other annotations, so no unused-type issue. oidc's old predicate was already
  `Record<string, unknown>`.
- Control-character regex `/[\u0000-\u001f\u007f]/` was textually identical at all 3 call
  sites; hoisting it to a module-level const without `/g` keeps `.test()` stateless, so
  `hasControlCharacter` is semantics-preserving. Call-site polarity preserved
  (`!hasControlCharacter` in usage's `boundedLabel`). The literal now exists only in
  `validate.ts:1` (repo-wide rg).
- `hasJsonContentType` correctly NOT adopted in oidc: bounded-body's version also accepts
  `*+json` suffixes while oidc requires exact `application/json` — not identical, so keeping
  oidc's stricter check matches the plan's "if identical" condition. Widening it would have
  been a behaviour change.
- All new imports are used in all four consumer files; `validate.ts` has zero imports (no
  cycle possible) and JSDoc on all four exports; `npx madge --circular` clean.
- No test changes needed or made: the deduped functions were private, so no test could import
  them; no `vi.mock` specifier concerns.
- No `index.ts` added; paths intact; singleton state, error classes/messages, headers, bounds
  untouched.
- Gates in worktree: `npm run typecheck` clean; full `npx vitest run`: 54 files / 664 tests pass.

No findings.

Verdict: PASS

## 4c4702a S4

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 4c4702a.
Diff is 5 files: `oauth.ts` split into `oauth-token.ts` + `oauth-browser.ts`, `auth.ts` repointed,
`refresh.test.ts` repointed.

Verification:

- Move is provably verbatim: a line-multiset check of parent `oauth.ts` against the three new
  files (ignoring import statements, blank lines, and added `export` prefixes) shows every old
  line present and the only new lines are 8 added JSDoc comments on newly-exported symbols.
  No error text, header, bound, timeout, or redaction change is possible outside imports.
- All remaining `oauth.ts` importers use only symbols that stayed (`createXaiOAuth`,
  `detectXaiLoginContext`, `XAI_BROWSER/DEVICE_LOGIN_METHOD`); every import in the new
  `oauth.ts` is used 2+ times (tsconfig has no `noUnusedLocals`, so checked by hand).
- Importers of the new modules are exactly `oauth.ts` (both), `auth.ts` (token), and
  `refresh.test.ts` (token). `oauth-browser.ts` uses `import type` for `XaiOidcDiscovery`, so
  it adds no runtime edge to OIDC; `http`/`crypto` usage moved with the callback server.
- No `vi.mock` of the oauth modules and no post-mock `await import` of them in tests, so the
  split is mock-safe. No test changes were needed beyond the `refresh.test.ts` import source.
- No module-level mutable state in any of the three files; no `index.ts`; `xai-oauth.ts` and
  `usage.ts` paths intact; `npx madge --circular` clean.
- Gates in worktree: `npm run typecheck` clean; full `npx vitest run`: 54 files / 664 tests pass
  (includes the real-callback `browser-login` suite exercising the moved server).

### [MINOR] S4 plan outcome overclaims OIDC unloading; file name also differs

- Where: `.scaffold/refactor/plan.md` S4 vs `extensions/xai/oauth-token.ts:7` (commit 4c4702a)
- Evidence: plan S4 says "`auth.ts` imports refresh from `oauth-token.ts` -> tools/usage no
  longer pull in the HTTP server, device auth, OIDC." But `oauth-token.ts` has a runtime value
  import of `discoverXaiOidc` from `./oidc` (needed by `refreshXaiCredentials`' stored-credential
  discovery fallback), so `auth.ts` -> `oauth-token.ts` -> `oidc.ts` still loads OIDC. The commit
  message already describes this accurately ("callback server or device authorization modules",
  no OIDC claim). Separately, the plan names the new file `oauth-callback.ts` but the commit
  created `oauth-browser.ts`, which also houses `buildAuthorizeUrl` (unlisted in the plan).
- Why it matters: the plan states a slice goal that is not true of the implementation, and the
  file name drift will confuse later slices/reviews that reference `oauth-callback.ts`. No
  runtime impact — the code split and load-graph improvement (no more `http` server or
  device-auth via `auth.ts`) are correct.
- Suggested fix: update plan.md S4 to `oauth-browser.ts` (listing `buildAuthorizeUrl`) and
  correct the unload sentence to HTTP server + device auth only, or record OIDC unloading as a
  follow-up (it would require moving the discovery fallback out of refresh).

Verdict: PASS WITH NITS

## 25202fb S5

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 25202fb.
Diff is 4 files: `tools/grok-native.ts` split into `grok-workspace-fs.ts`, `grok-grep.ts`,
`grok-search-replace.ts`; no test files touched.

Verification:

- Move is verbatim except one intentional value-preserving edit: a line-multiset check of
  parent `grok-native.ts` against the four new files shows every old line present (modulo added
  `export` prefixes) and the only new lines are 4 added JSDoc comments — plus the byte-ceiling
  consts' dependency direction flipped (`MAX_GROK_GREP_FILE_BYTES = 5_000_000` /
  `MAX_GROK_NATIVE_TEXT_FILE_BYTES = MAX_GROK_GREP_FILE_BYTES` became `..._TEXT_... = 5_000_000`
  in workspace-fs with `..._GREP_... = ..._TEXT_...` in grep). Both consts still equal 5_000_000;
  the flip is required for the layering (grep imports workspace-fs, not vice versa).
- No test updates needed and none made: the only `grok-native` importers (`tools/index.ts`,
  `grok-native.test.ts`, `grok-native-search-errors.test.ts`) use `registerGrokNativeTools` /
  `syncGrokNativeToolsForModel`, which stayed. `web_search`, schemas, executors, registration,
  and active-tool sync all remain in `grok-native.ts`.
- Mock-safe: parent and new files all use the `node:`-prefixed specifiers (`node:fs`,
  `node:fs/promises`, `node:worker_threads`, `node:path`), so the post-mock `await import` of
  `grok-native` in `grok-native-search-errors.test.ts` still hits the moved grep walker through
  the registry-wide `node:fs/promises` mock (suite passes).
- Worker path intact: loader is `new URL("./grok-native-grep-worker.mjs", import.meta.url)` in
  `grok-grep.ts`, same directory as before, `.mjs` untouched beside it.
- Layering is acyclic: search-replace is import-free; workspace-fs imports only node builtins +
  `../abort` + `grok-native-args`; grep adds only workspace-fs; no back-imports to `grok-native`.
  `npx madge --circular` clean.
- No unused imports: `npx tsc --noEmit --noUnusedLocals` passes project-wide (covers the touched
  files; tsconfig itself does not enable the flag). No module-level mutable state moved or added;
  no `index.ts` added (`tools/index.ts` pre-existed, untouched); paths intact.
- Plan conformance: matches S5 exactly (workspace-fs/grep/search-replace split, `.mjs` beside
  the loader, `grok-native.ts` keeps schemas/executors/registration/sync/`web_search`).
- Gates in worktree: `npm run typecheck` clean; full `npx vitest run`: 54 files / 664 tests pass.

No findings.

Verdict: PASS

## db07d7c S6

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached db07d7c.
Diff is 12 files: `responses.ts` split into `redirect-guard.ts`, `assistant-stream.ts`,
`responses-delegate.ts`, `responses-request.ts`; `XAI_VISION_DESCRIPTION_ERROR` moved to
`constants.ts`; 2 tool modules + 3 test files repointed.

Verification:

- Move is provably verbatim: a line-multiset check of parent `responses.ts` against the five
  new files (ignoring imports, blanks, added `export` prefixes) shows every old line present
  and the only new lines are JSDoc comments on newly-exported symbols. No error text, header,
  bound, timeout, or redaction change is possible outside imports.
- Singleton guard state (`guardedRedirectUrls`, `unguardedFetch`, `redirectGuardFetch`) moved
  wholly to `redirect-guard.ts`; repo-wide rg confirms no retained or duplicated copy — sole
  owner as the plan requires. `responses.ts` consumes it via `acquireRedirectGuard` only.
- All newly-exported helpers (`pinXaiPayloadModel`, `SAFE_PAYLOAD_MODEL_ERROR`, delegate
  identity/repair fns, stream fns, `assertXaiRuntimeModelAcceptsPayload`) are imported only by
  `responses.ts`; `normalizeXaiStreamEvent` stays private in `responses.ts`. No test imports the
  internals, and no test file uses `vi.mock`/`await import` in `tests/responses/` — mock-safe.
- Import graph goals achieved: `responses-request.ts` imports no vision-routing and no OpenAI
  delegate; both tool modules now import it directly instead of `responses.ts`. `xai-oauth.ts`
  still resolves `streamSimpleXaiResponses` from `./xai/responses`.
- `XAI_VISION_DESCRIPTION_ERROR` string is char-identical in `constants.ts`; parent-tree grep
  confirmed the only importers were `responses.ts`/`vision-routing.ts`, and all 4 use sites
  (2 in `responses.ts`, 2 in `responses-request.ts`) plus `vision-routing.ts:318` resolve to the
  constants import. `constants.ts` diff is purely additive (4+/0-).
- `tests/responses/routing.test.ts` split its import block correctly (`streamSimple...` stays on
  `responses`, `createXaiResponse`/`postXaiJson` move to `responses-request`); same pattern in
  `images` and `vision-routing` tests.
- No unused imports (`tsc --noUnusedLocals` clean project-wide); `npx madge --circular` clean;
  no `index.ts`; `xai-oauth.ts`/`usage.ts`/worker paths intact.
- Plan conformance: matches S6 v2 exactly (four modules with the specified contents,
  `responses.ts` keeps `streamSimpleXaiResponses` + `normalizeXaiStreamEvent`, tools import
  `responses-request.ts` directly, description error in `constants.ts`).
- Gates in worktree: `npm run typecheck` clean; full `npx vitest run`: 54 files / 664 tests pass.

No findings.

Verdict: PASS

## 74cea95 S7

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 74cea95.
Diff is 6 files: `catalog.ts` split into `catalog-normalize.ts` + `catalog-cache.ts`; 3 test files
repointed (`cache-write-failure.test.ts` untouched, as planned).

Verification:

- Move is verbatim except the one flagged delegation: a line-multiset check of parent
  `catalog.ts` against the three new files shows every old line present (modulo added `export`
  prefixes) and the only non-JSDoc diffs are the extracted `validateCachedXaiCatalogModels`
  wrapper, its 2-line call site, and the `models:` shorthand. All consts, both error classes
  (message text included), the write queue, atomic write, rollback, and tombstone are untouched.
- `readCache` delegation verified semantics-identical by line-by-line comparison: the new
  `validateCachedXaiCatalogModels(obj.models, obj.schemaVersion as number)` performs the same
  array/bound check, the same `.map(validateCachedModel)` with the same arguments, the same
  `.some(!model)` rejection, and the same duplicate/API-key-only loop in the same order, and
  returns `models as XaiCatalogModel[]` exactly as the inline code produced. Throw paths are
  preserved (the call sits inside `readCache`'s `try`, so any throw still yields `undefined`).
  Single-vs-double `obj.models` access is unobservable (plain `JSON.parse` result, no getters).
- Singleton state: the single `cacheWriteQueues` map lives only in `catalog-cache.ts`
  (consumed via `withCacheWriteQueue`); `XaiCatalogCancelledError` defined once in cache,
  `XaiCatalogValidationError` once in normalize. No duplicates.
- Specifier style preserved: parent used bare `fs/promises` + `path`; `catalog-cache.ts` and
  the remaining `catalog.ts` direct import keep them exactly, so the untouched
  `cache-write-failure.test.ts` (mocks both specifiers, then `await import`s `catalog`) still
  intercepts the moved cache code — suite passes.
- Layering: cache imports normalize (validator only); normalize imports just models + validate
  (no back-edge); `catalog.ts` keeps fetch + selection and still exports
  `fetchXaiModelCatalog`/`selectXaiModelCatalog` for `xai-oauth.ts` and the tests. All moved
  symbols' importers updated (3 test files + `catalog.ts`); `validateCachedModel` stays private.
- No unused imports (`tsc --noUnusedLocals` clean project-wide); `npx madge --circular` clean;
  no `index.ts`; paths intact.
- Plan conformance: matches S7 v2 exactly.
- Gates in worktree: `npm run typecheck` clean; full `npx vitest run`: 54 files / 664 tests pass.

No findings.

Verdict: PASS

## 5e3645f S8

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 5e3645f.
Diff is 6 files: `usage.ts` split into `usage-parse.ts` + `usage-render.ts`; 3 usage test files
repointed.

Verification:

- Move is fully verbatim: a line-multiset check of parent `usage.ts` against the three new files
  (ignoring imports, blanks, added `export` prefixes) shows zero missing and zero new lines —
  not even added JSDoc. No error text, bound, timeout, render, or redaction change is possible.
- Test repointing correct: parse fns + `XaiUsageError` + `XaiUsageSnapshot` (via `import type`)
  from `usage-parse`; render fns from `usage-render`; `registerXaiUsage`/`fetchXaiUsage` stay on
  `usage`. Importer map is complete: new modules imported only by `usage.ts` + the 3 test files;
  `xai-oauth.ts` still resolves `registerXaiUsage` from `./xai/usage` at its pinned path.
- Layering: parse imports only constants + validate; render imports only a type from parse
  (`import type`, erased at runtime); no back-edges. `npx madge --circular` clean.
- No module-level mutable state in any of the three files; status lifecycle unchanged in
  `usage.ts`. No `vi.mock`/`await import` in `tests/usage/` — mock-safe. No unused imports
  (`tsc --noUnusedLocals` clean project-wide). No `index.ts`; paths intact.
- Plan conformance: matches S8 exactly (parse/validate + `XaiUsageError` + types in parse;
  render + status text in render; transport + command + status lifecycle in `usage.ts`).
- Gates in worktree: `npm run typecheck` clean; full `npx vitest run`: 54 files / 664 tests pass.

No findings.

Verdict: PASS

## 616aa78 S9

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 616aa78.
Diff is 7 files: `payload.ts` split into `payload-tool-names.ts` + `payload-images.ts`;
3 extension modules + `payload.test.ts` repointed.

Verification:

- Move is verbatim: a line-multiset check of parent `payload.ts` against the three new files
  shows every old line present and the only new lines are 3 added JSDoc comments. No error
  text, canonicalization, policy, rewrite, or redaction change is possible outside imports.
- `normalizeXaiResponsesInput` (private in parent) moved with the image helpers as planned and
  is now exported from `payload-images.ts`; its single caller is the `payload.ts` rewrite
  (line 71). Intended visibility change, no behavior impact.
- Repointing complete and correct: tool-name fns + `GrokNativeToolRoutes` from
  `payload-tool-names`; image detection/omission/placeholder from `payload-images`;
  canonicalization/policy/rewrite/`XAI_PAYLOAD_CANONICALIZATION_ERROR` stay on `payload` and
  every remaining `payload` import resolves to a symbol that stayed (verified per import block).
- Direction constraint holds: `payload-tool-names.ts` imports only constants,
  `payload-images.ts` only pi-ai types + `images` + `text` — neither imports `payload.ts`.
  `npx madge --circular` clean.
- No unused imports (`tsc --noUnusedLocals` clean project-wide); no module state moved or added;
  no `index.ts`; no `vi.mock` interaction (payload tests use static imports); paths intact.
- Plan conformance: matches S9 exactly.
- Gates in worktree: `npm run typecheck` clean; full `npx vitest run`: 54 files / 664 tests pass.

No findings.

Verdict: PASS

## 9515851 S10

Reviewed in worktree `/home/justin/projects/pi-xai-oauth-pi-review` at detached 9515851.
Diff is 3 markdown files only (AGENTS.md, README.md, wire-protocol) — no code, so no behavior
change is possible.

Verification:

- Every new module from S1–S9 exists on disk and is referenced in both trees: all 13 new
  `extensions/xai/*.ts` files appear in AGENTS.md and README.md with descriptions matching
  their actual contents (verified per line against the modules); the S5 `tools/` splits are
  annotated parenthetically in the AGENTS.md `tools/` line, consistent with that tree's prior
  granularity (README never enumerated `tools/` children). README tree is exhaustive; no
  listed file is missing and no existing module was dropped from either tree.
- AGENTS.md core-flow line correctly names `oauth-browser.ts`/`oauth-token.ts` and
  `responses-request.ts`; all old one-line descriptions of split files were replaced.
- Repo-wide rg for stale module-path references in the three docs found none (remaining
  `vision-routing` prose mentions are feature behavior, not module paths).
- Wire-protocol re-audit list (step 4) adds exactly the new wire-touching modules
  (`responses-request.ts`, `redirect-guard.ts`, `oauth-browser.ts`, `oauth-token.ts`); the
  non-wire splits (delegate, stream, parse/render, normalize/cache, tool-names/images) are
  correctly absent.
- Gates in worktree (final tree): `npm run typecheck` clean; full `npx vitest run`: 54 files /
  664 tests pass.

### [NIT] S10 plan item `.scaffold/progress.md` not updated

- Where: `.scaffold/refactor/plan.md` S10 vs commit 9515851 (docs)
- Evidence: plan S10 lists `.scaffold/progress.md`, but the commit touches only the three
  markdown docs. `progress.md` (tracked in git) still describes only Issue #188 / v1.5.1 from
  `9d6f78f`; refactor progress lives in `.scaffold/refactor/` (plan Progress line, `log.md`) by
  multi-agent-protocol design instead.
- Why it matters: plan-conformance hygiene only; no code or shipped-doc impact.
- Suggested fix: either append a refactor entry to `progress.md` or drop it from the S10 plan
  line, since `refactor/` already carries the branch state.

Verdict: PASS WITH NITS

## Handoff to Codex

Pi's per-commit reviews are above (8 code slices + S10 docs; all PASS / PASS WITH NITS).
Method per slice: detached-worktree review, line-multiset verbatim check of parent vs split
files (S4/S5/S6/S7/S8/S9 all verbatim except noted items), importer/`import type`/specifier/
`vi.mock` audits, `tsc --noUnusedLocals`, `madge --circular`, typecheck + full suite (664/664)
every slice. Claude's brief asked me to flag the riskiest spots for your full-branch sweep —
here they are, ranked:

1. S7 `readCache` delegation (the only deliberate logic touch in a behavioral path):
   `extensions/xai/catalog-cache.ts:84` now calls `validateCachedXaiCatalogModels`
   (`extensions/xai/catalog-normalize.ts:404`) instead of inline checks. I verified it
   line-by-line as semantics-identical (same checks/order/args, throw→`undefined` preserved
   inside `readCache`'s try). Please re-verify independently — this deserves two pairs of eyes.
2. S6 redirect-guard singleton (`extensions/xai/redirect-guard.ts`): `globalThis.fetch`
   patching with URL refcounting moved here; I confirmed single ownership and no duplicate
   state. Worth re-checking overlapping-caller acquire/release interleavings and that no caller
   regressed to an unguarded fetch.
3. S5 byte-ceiling const flip: `MAX_GROK_GREP_FILE_BYTES`/`MAX_GROK_NATIVE_TEXT_FILE_BYTES`
   dependency direction reversed across `grok-workspace-fs.ts:8` / `grok-grep.ts:17` (both still
   5_000_000; required for layering). Also the grep worker loader `new
   URL("./grok-native-grep-worker.mjs", import.meta.url)` moved files but stayed in the same
   directory — confirm worker resolution in packed/loader contexts.
4. S4 `auth.ts` → `oauth-token.ts` edge: `oauth-token.ts` still runtime-imports `oidc.ts` for the
   refresh discovery fallback (plan-corrected as a non-goal, commit message accurate). Confirm
   no cycle and that the `http` server / device-auth are truly out of the tools/usage load graph.
5. S2 `hasControlCharacter` regex hoist (no `/g` flag, `.test` stateless — I verified identical)
   and the `isRecord` predicate change (`JsonRecord` alias = `Record<string, unknown>`).
6. S9 `normalizeXaiResponsesInput` newly exported from `payload-images.ts` (single caller:
   `payload.ts:71`); S1 `"xai-auth"` → `XAI_PROVIDER_ID` literal swap (value-verified).
7. Error-string / header-contract spot checks: my verbatim checks prove no body line changed
   outside imports, but an independent grep of a few critical strings (state-mismatch HTML,
   token-endpoint errors, `x-grok-*` headers) against `main` would add confidence.
8. Open plan-doc nits (no code impact): S4 resolved in plan v2 already; S10 `.scaffold/progress.md`
   item above still open.

- Resolution (4c4702a MINOR): accepted. plan.md S4 now names `oauth-browser.ts` (including `buildAuthorizeUrl`) and claims only "no callback server, no device auth". OIDC unloading is recorded as a non-goal, because refresh needs the discovery fallback.

- Resolution (9515851 NIT): accepted. `.scaffold/progress.md` now records the refactor. It will be committed with the `.scaffold/` state after the Codex review, so Codex's tree stays unchanged during its sweep.
