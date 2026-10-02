# Module survey (read-only, `main` @ f312a4d)

Paths are under the repo root; `X/` = `extensions/xai/`. Line numbers are approximate pointers — verify before acting.
No circular imports exist among the 37 extension modules.

## 1. The 10 largest files

- **`X/tools/grok-native.ts` (1128)** mixes nine concerns: TypeBox schemas (85-174), glob-to-regex (176-216), regex safety guard (222-289), workspace containment (300-367), bounded no-follow file read (369-410), grep walker plus worker (412-707), CRLF/BOM exact replace (709-795), executors and terminal environment policy (797-947), active-tool sync (949-980). The paid network `web_search` tool (1071-1127) also sits in this "local adapter" module.
  - candidate `tools/grok-workspace-fs.ts`: `containedWorkspacePath`, `toWorkspaceToolPath`, `physicalWorkspaceSearchPath`, `readContainedTextFile`, `pathIsWithin`.
  - candidate `tools/grok-grep.ts`: `runLocalGrep`, `createSafeRegexMatcher`, `globMatches`, `GrokGrepMatcher`.
  - candidate `tools/grok-search-replace.ts`: `buildExactSearchReplaceContent` and helpers.
  - `grok-native.ts` keeps `registerGrokNativeTools`, `syncGrokNativeToolsForModel`.
- **`X/responses.ts` (806)**: redirect guard patching global `fetch` (65-123), encrypted-reasoning replay repair (139-215), event normalization (217-274), forwarding stream (276-353), `postXaiJson` (368-400), `createXaiResponse` (454-517), `streamSimpleXaiResponses` (539-806) whose `onPayload` closure is ~100 lines (665-762).
  - candidates: `redirect-guard.ts` (`acquireRedirectGuard`), `assistant-stream.ts` (`createForwardingAssistantStream`, `streamErrorMessage`), `reasoning-replay.ts` (`prepareXaiDelegateContext`, `shouldOmitRejectedEncryptedReasoning`, `omitRejectedEncryptedReasoning`, `restoreXaiMessageIdentity`), `xai-request.ts` (`postXaiJson`, `createXaiResponse`, `assertXaiRuntimeModelAcceptsPayload`).
- **`X/catalog.ts` (807)**: validators (101-160), `/models-v2` normalization (171-396), cache-record validation (406-495), cache filesystem work — marker, atomic write, queue, rollback, tombstone (497-664) — fetch (667-710), selection policy (716-807).
  - candidates: `catalog-normalize.ts` (`normalizeXaiCatalogPayload`, `XaiCatalogValidationError`), `catalog-cache.ts` (`defaultXaiCatalogCachePath`, `readCache`, `writeAtomicJson`, `invalidateCache`, `restorePreviousCache`, `withCacheWriteQueue`). `catalog.ts` keeps `fetchXaiModelCatalog`, `selectXaiModelCatalog`, `XaiCatalogCancelledError`.
- **`X/usage.ts` (710)**: parsing/validation (91-319), transport (321-423), rendering (425-493), `/xai-usage` command + status lifecycle (495-710).
  - candidates: `usage-parse.ts` (`parseXaiUsage`, `parseXaiUserId`, `XaiUsageError`, types), `usage-render.ts` (`renderXaiUsage`, `renderXaiUsageStatus`). `usage.ts` keeps `fetchXaiUsage`, `registerXaiUsage` (path is checked by the pack script).
- **`X/tools/custom-tools.ts` (639)**: one 586-line function (53-639) registering 10 tools; each repeats enabled-check → credential → call → format error. Seam: a `defineXaiResponsesTool({name, buildBody, render})` helper. Image-edit (363-444) and image-to-video (446-517) share error-to-tool-result mapping.
- **`X/payload.ts` (639)**: canonicalize + OAuth policy (15-51), Grok tool-name mapping (53-165), image parts (167-211, 486-553), consumed-image omission (213-433), rewrite (435-639).
  - candidates: `payload-tool-names.ts` (`exposeGrokNativeToolNames`, `internalizeGrokNativeToolCalls`, `xaiPayloadGrokNativeToolRoutes`, `GrokNativeToolRoutes`), `payload-images.ts` (`normalizeXaiResponsesImageParts`, `xaiResponsesPayloadContainsImage`, `xaiResponsesPayloadContainsLocalImageReference`, `omitConsumedXaiResponsesVisionImages`, `HISTORICAL_USER_IMAGE_PLACEHOLDER`).
- **`X/oauth.ts` (589)**: login-context detection (46-98), callback HTTP server (168-289), authorize URL + manual paste (291-334), token exchange + refresh (131-166, 336-393), provider factory (396-589).
  - candidates: `oauth-token.ts` (`refreshXaiCredentials`, `ensureFreshXaiCredentials`, `exchangeXaiToken`, `credentialsFromTokenPayload`), `oauth-callback.ts` (`startCallbackServer`, `parseCallbackInput`, `pkcePair`).
- **`X/tools/commands.ts` (493)**: status text, select loop, terminal picker, arg parser, event-bus bridge. Mixed indentation (spaces 1-288, tabs 291-493). Low payoff.
- **`X/auth.ts` (476)**: Grok CLI file reuse (23-98), startup auth (100-145), registry probing (158-355), resolvers (357-476). Mostly cohesive.
- **`X/models.ts` (430)**: static metadata, mutable runtime snapshot (`runtimeModels` ~251), capability checks. Cohesive; re-exports `resolveXaiClientMode`/`xaiProxyRequestHeaders` from `wire.ts` at 4-9.

## 2. Duplicated logic

- Fetch with timeout + cancel/timeout/transport error sorting, 5×: `image-edit.ts:217-241`, `image-to-video.ts:189-206`, `usage.ts:370-385`, `device-auth.ts:134-152`, `catalog.ts:672-684`.
- Bounded JSON read + parse + object check, 4×: `device-auth.ts:70-89`, `image-to-video.ts:151-187`, `image-edit.ts:253-262`, `usage.ts:390-403`.
- Unbounded `response.json()` bypassing bounded readers: `oidc.ts:67`, `oauth.ts:356`, `responses.ts:399`. `oidc.ts:61` re-implements `hasJsonContentType` (`bounded-body.ts:13`).
- Hand-rolled abort/timeout: `video-download.ts:110-114` (+ guessed timeout at 232); abort forwarding `xai-oauth.ts:75-77`, `usage.ts:639-641`; timer+abort races `oauth.ts:264-286`, `grok-native.ts:534-538`.
- Transient-status check 3×: `catalog.ts:689`, `image-to-video.ts:208-210`, `device-auth.ts:301`.
- Small validators: object check `catalog.ts:101`, `usage.ts:95`, `device-auth.ts:58`, `oidc.ts:56`; `positiveInteger` `catalog.ts:131`, `device-auth.ts:97`; control-char regex `catalog.ts:145`, `usage.ts:124`, `device-auth.ts:93`; `messageFromError` `oauth.ts:100` vs `text.ts:48`.
- Path containment 5×: `grok-native.ts:300-306` + `:363`, `grok-native-args.ts:303`, `media/paths.ts:19-23`, `media/output-storage.ts:203-210`.
- No-follow bounded file read: `grok-native.ts:375-406` vs `media/paths.ts:56-72`, `:97-101`.
- Image reference validation `image-edit.ts:100-122` vs `image-to-video.ts:74-90`; `SessionLocation` declared 3× (`image-edit.ts:48`, `image-to-video.ts:33`, `media/output-storage.ts:198`).
- Tool error strings: "xAI API Error ${status}" in `custom-tools.ts` (8×) + `grok-native.ts:1122`; "No xAI OAuth credentials" 10× in `custom-tools.ts` + `grok-native.ts:1096`.
- Active-tool guard/diff: `grok-native.ts:955-979` vs `model-scope.ts:78, 110-111, 134-165`.
- Entrypoint/auth: bearer extraction `xai-oauth.ts:162-169` vs `auth.ts:240-254`; "model no longer entitled" block 2× `xai-oauth.ts:205-224`, `238-259`; fallback catalog selection `xai-oauth.ts:48-52` vs `catalog.ts:398-404`.
- Smaller: image-part check `payload.ts:199-211` vs `541-549`; `image_url` unwrap `payload.ts:180-188` vs `vision-routing.ts:207-218`; quote stripping `images.ts:42-51` vs `payload.ts:512-517`; model-id normalization `wire.ts:126-127` vs `models.ts:398-400`.

## 3. Import graph

- Cycles: none.
- Fan-in: constants 16, media/constants 11, abort 10, routing 9, media/types 9, wire 8, models 7, bounded-body 7.
- Deep coupling: tools (`custom-tools.ts:2`, `grok-native.ts:22`) and `usage.ts:8-11` import `auth.ts`; `auth.ts:20` imports `oauth.ts`, which pulls in the callback HTTP server, device auth and OIDC — only for `ensureFreshXaiCredentials`.
- `tools/commands.ts:7-10` imports `vision-routing.ts` (→ payload, images, media paths) just for `XAI_VISION_ROUTING_NAME` and one type.
- Pass-through: `models.ts:4-9` re-exports from `wire.ts`. `tools/index.ts` owns the register-once guard — keep.
- `vision-routing.ts:94` uses literal `"xai-auth"` instead of `XAI_PROVIDER_ID`.

## 4. Test blast radius

- No test imports an unexported symbol.
- `tests/provider/models.test.ts`, `tests/responses/routing.test.ts` import `resolveXaiClientMode` from `models.ts` (via the re-export).
- `tests/catalog/cache-write-failure.test.ts:44-45` mocks both `"fs/promises"` and `"node:fs/promises"` (catalog imports `fs/promises`).
- `tests/tools/grok-native-search-errors.test.ts:7` mocks only `"node:fs/promises"` (`readdir`) — moved grep code must keep the `node:` prefix.
- `tests/media/path-races.test.ts:21,40` hooks `open/stat/openSync/statSync` one-shot — sharing a file reader between grok-native and media would make these hooks fire for it too.
- Those three tests `await import` after mocking: `X/catalog` and `X/tools/grok-native` must keep exporting `selectXaiModelCatalog` and `registerGrokNativeTools`.
- Importers: responses.ts ← `responses/{images,routing,streaming,reasoning-recovery,vision-routing}.test.ts`; payload.ts ← `responses/payload.test.ts`, `responses/images.test.ts`; catalog.ts ← 4 files in `tests/catalog/`; usage.ts ← 3 in `tests/usage/`; oauth.ts ← 6 in `tests/oauth/`; auth.ts ← `provider/{credentials,registry-reregistration}.test.ts`; custom-tools.ts ← `tools/{custom-tools,commands}.test.ts`, `images/{tools,image-edit-tool}.test.ts`; abort/bounded-body ← `setup/shared-primitives.test.ts`.
- ~20 tests call `setXaiRuntimeModels`; `runtimeModels` (`models.ts:251`) must stay a single instance.

## 5. Public surface that must stay stable

- No `index.ts` or new top-level `.ts` under `extensions/` (`package.json` `pi.extensions: ["./extensions"]`; the loader loads `extensions/*.ts` and `extensions/*/index.ts`). Deeper folders are not recursed.
- `extensions/xai-oauth.ts` default export is loaded by `scripts/verify-extension-loader.mjs:25`, which asserts tool/command/provider names.
- `scripts/verify-compatibility.js:221-222` requires `extensions/xai-oauth.ts` and `extensions/xai/usage.ts` in the tarball.
- `constants.ts:1` imports `../../package.json`; `grok-native.ts:488` loads the grep worker by relative URL (the `.mjs` must stay beside its loader).
- `tools/index.ts` exports only `registerXaiTools`, `syncXaiToolsForModel` (sole importer `xai-oauth.ts:16`).
- `XAI_TOOLS_MENU_CHANNEL` (`commands.ts:50`) is an external event channel (`docs/bridge-xai-tools.md`).
- `bin/setup.js` imports no extension code.
- Docs citing module paths: `AGENTS.md:9, 72-83`, `compatibility/grok-build-wire-protocol.md:10, 120`.
