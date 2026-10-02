# Pi 1.0 research (Grok)

Sources: Pi 0.84.2 and 1.0.0 reference installs, `pi-coding-agent/CHANGELOG.md`, `extensions/`, `tests/catalog/reasoning-parity.test.ts`. Ranked by risk. `getSupportedThinkingLevels` is the same function in 0.84.2 `models.js:548` and 1.0 `models.js:681`.

### [BLOCKER] Compat `streamSimple` does not fold a plain Context

- Where: `extensions/xai/responses.ts:213` (`prepareXaiDelegateContext`) and `:255-257` (delegate call). Pi: `pi-ai/dist/types.d.ts:526-547`, `dist/utils/transcript.js:23-26`, `dist/api/openai-responses.js:93-95` and `:177-188`, `dist/models.js:446-462`. 0.84 converter: `dist/api/openai-responses-shared.js:90-99`.
- Evidence: `TranscriptContext` is `{ messages; readonly [transcriptContextBrand]: true }`. Only `normalizeContext()` produces it. The function returns `{ messages }` and never writes the symbol, so the brand is type-only. It prepends one system message (`content`, optional `toolsAdded`) when `systemPrompt` or `tools` is non-empty, and it is a no-op when both are absent. Public `Models.streamSimple` calls it (`models.js:458`). Compat `streamSimple` does not: `stream` calls `resolveTranscript`, which only collapses `context.messages` (`transcript.js:102-104`). README `:1353` says direct calls bypass normalization. 0.84 `convertResponsesMessages` reads `context.systemPrompt` (`:90`) and skips `role: "system"` (`:99`). 1.0 reads system text and `toolsAdded` (`openai-responses-shared.js:63-139`). `prepareXaiDelegateContext` (`responses-delegate.ts:22-37`) retags assistant `api` and spreads shorthand fields through. Host custom providers have received a normalized transcript since `## [0.86.0] - 2026-09-19` (1.0 `types.d.ts:1378-1388`). A cast still drops shorthand fields that were not folded. Folding on every call drops the prompt on 0.84.
- Why it matters: from 0.86.0 on, a shorthand `Context` sent to the compat delegate goes out with no system prompt and no tools. The 1.0 typecheck error at `responses.ts:257` is that runtime bug showing up as types.
- Suggested fix: retag first, then adapt. Do not static-import `normalizeContext` (absent on 0.80.1 / 0.84.2). `Parameters<>` tracks whichever second argument the installed `streamSimple` has.

```ts
import * as piAi from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";

type DelegateContextArg = Parameters<typeof streamSimpleOpenAIResponses>[1];

function toDelegateContext(context: Context): DelegateContextArg {
  const normalize = (piAi as {
    normalizeContext?: (context: Context) => DelegateContextArg;
  }).normalizeContext;
  // Absent before 0.86.0. That Responses converter reads systemPrompt/tools.
  if (!normalize) return context as DelegateContextArg;
  const shorthand = context.systemPrompt !== undefined || context.tools !== undefined;
  const leadingSystem = context.messages[0]?.role === "system";
  // A leading system message is already the transcript. Normalizing again
  // would prepend a second one when shorthand fields were also copied.
  if (!shorthand || leadingSystem) return context as DelegateContextArg;
  return normalize(context);
}
```

Pass `toDelegateContext(delegateContext)` at `responses.ts:257`.

### [MAJOR] grok-4.3 advertises `minimal` because our map sets a string

- Where: `extensions/xai/models.ts:98-105`, `catalog-normalize.ts:152-174`, `payload.ts:111-114`, `tests/catalog/reasoning-parity.test.ts:60-63`. Rule: 1.0 `models.js:681-691` (identical at 0.84.2 `:548-558`). README `:1323`.
- Evidence: with `reasoning`, each of `off` through `high` is shown when the map entry is missing or a string, and hidden when it is `null`. `xhigh` and `max` show only for a string, so absent and `null` both hide them (README `:1323`). Our map sets `minimal: "low"`, so both hosts advertise `off, minimal, low, medium, high`. 0.84.2 built-in `grok-4.3` has no map, so the missing-key rule also shows `minimal`. 1.0 `chat:grok-4.3` sets `minimal: null` (and `off: "none"`, `xhigh`/`max` null), so its list is `off, low, medium, high`. `clampThinkingLevel` runs in `streamSimple` (`openai-responses.js:183`) before `payload.ts:114` rewrites a leftover `minimal` to `low`. `/thinking` arrived in `## [0.84.3] - 2026-08-24`. Picker and clamped effort both change.
- Why it matters: one static map cannot equal both built-in lists. Equality with 0.84.2 over-advertises a level xAI does not implement as its own effort.
- Suggested fix: emit `{ off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null }` and omit `max` (0.80.1 has no `max` member; absent hides `xhigh` / `max` on 0.84 and 1.0). Supported set on both hosts: `off, low, medium, high`. A saved `minimal` clamps forward to `low`. In `catalog-normalize.ts`, leave grok-4.3 `minimal` null even if `/models-v2` lists that name; keep the grok-4.5 / grok-4.6 `minimal: "low"` alias (tests lock it in). Point the parity test at this xAI set. On 1.0 it matches the built-in. On 0.84.2 record the built-in extra `minimal` the way grok-4.5 already records an intentional gap.

### [MAJOR] Built-in catalog: grok-build-0.1 gone, grok-4.7 added

- Where: both `pi-ai/dist/providers/data/xai.json`. Tests: `reasoning-parity.test.ts:53-54` and `:119-120`. Removal: `## [0.85.0] - 2026-09-04`. Addition and default: `## [0.87.1] - 2026-09-22`. Responses switch and Grok 4.6 default: `## [0.84.3] - 2026-08-24`.
- Evidence: 0.84.2 ids are `grok-4.3`, `grok-4.6`, `grok-build-0.1` (`openai-completions`, no map) and `grok-4.5` (`openai-responses`, `minimal: null`). 1.0 ids, all `openai-responses` under keys `chat:<id>`, are `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-4.7`. No renames. `grok-4.7` matches 4.6: reasoning, 500k/500k, text+image, cost 2/6/0.5/0, `minimal: null`, `xhigh: "xhigh"`. Each 1.0 model adds cost tier `inputTokensAbove: 200000` and `compat.supportsLongCacheRetention: false`. Built-in grok-4.3 `maxTokens` stays 30000; ours is 131072 (`models.ts:97`). `API_KEY_ONLY_MODEL_IDS` still lists `grok-build-0.1` (`catalog-normalize.ts:14`).
- Why it matters: `:54` and `:120` require the removed id on every boundary, so 0.85.0+ fails typecheck and the inventory test. Snapshotting api, compat, or cost against 0.84.2 will fail once latest moves.
- Suggested fix: stop requiring `XAI_MODELS["grok-build-0.1"]` to exist. Keep asserting xai-auth never advertises it. Assert `grok-4.7` only when that installed catalog has it. Compare grok-4.3 levels to the set above. Leave our `maxTokens` and cost as package metadata; do not require them to equal the built-in row.

### [MINOR] Call sites are stable except the stream context and `toolChoice`

OAuth callbacks are byte-identical (`compat/extension-oauth-types.d.ts`): `onAuth`, `onDeviceCode`, `onPrompt`, optional `onProgress` / `onManualCodeInput`, required `onSelect`, optional `signal`. `ProviderConfig.oauth` still has `login`, `refreshToken(credentials, signal)`, `getApiKey`, and optional deprecated `usesCallbackServer` (already "canonical flows ignore it" at 0.84.2 `types.d.ts:1067` and 1.0 `:1410`). Sites: `oauth.ts:128`, `:135`, `:152`, `:164`, `:194`, `:206`. Keep the flag; the manual-input race at `:192-206` depends on hosts that still honor it.

`registerProvider` / `unregisterProvider` match (`xai-oauth.ts:61-62`, config cast `as any`). The real change is `streamSimple`'s context, `Context` at 0.84 `types.d.ts:1049` and `TranscriptContext` at 1.0 `:1388`. `registerTool` matches; 1.0 adds optional fields whose default keeps direct tools active (`types.d.ts:462-482`): `outputSchema`, `exposure`, `namespace`, `annotations`, `defaultActive`, `prepareLoadout`. Sites: `custom-tools.ts`, `grok-native.ts:324-411`. `registerCommand` matches (`commands.ts:355`, `usage.ts:272`). `getActiveTools` / `setActiveTools` match and stay feature-detected (`model-scope.ts:53-160`, `grok-native.ts:295-316`). `getAgentDir(): string` matches (`catalog-cache.ts:37`, `auth.ts:117`). `BashToolOptions.spawnHook` is in 0.84.2 `bash.d.ts:64` and unchanged; `ReadToolOptions.operations` stays optional (`grok-native.ts:399`). `ProviderRequestOptions` matches (`signal` `:58`, `apiKey` `:61`, `onPayload` `:78`, `headers` `:91`, `maxRetries` `:101`); we override them at `responses.ts:260-270`. 1.0 `SimpleStreamOptions` adds optional `toolChoice`, forwarded at `openai-responses.js:181` (`## [0.84.3]`). Spreading `options` sends a host `toolChoice` to xAI.

`ctx.ui` `notify` / `select` / `custom` / `setStatus` (`usage.ts`, `commands.ts`) keep their signatures. `auth.ts:274-304` already prefers `ModelRuntime.getAuth`. Events at `xai-oauth.ts:195-267` still exist, and `InputEventResult` is unchanged. `pi.on` returns an unsubscribe since `## [0.86.0]` (1.0 `types.d.ts:1144`); we ignore it. We do not subscribe to `user_bash` (fail-closed in that heading) or `context` (0.87.0 hides system messages from those handlers).

### Timeline

| Release | What hits us |
|---|---|
| `## [0.84.3] - 2026-08-24` | Built-in xAI models switch to Responses; Grok 4.6 default; `/thinking`; `toolChoice` on simple streams |
| `## [0.84.4] - 2026-08-28` | `ui_prompt_start` / `ui_prompt_end` (unused) |
| `## [0.85.0] - 2026-09-04` | `grok-build-0.1` removed |
| `## [0.86.0] - 2026-09-19` | `TranscriptContext`; `pi.on` unsubscribe; JSON-only tool arguments/details; `user_bash` fail-closed |
| `## [0.87.0] - 2026-09-21` | `context` hides system messages; `turn_end` may return a result (void still allowed) |
| `## [0.87.1] - 2026-09-22` | `grok-4.7` added and made the default xAI model |
| `## [1.0.0] - 2026-10-01` | No further xAI stream break. The typecheck failure is the 0.86 contract |

### Recommendation

Keep `minimum` at `0.80.1`. Branch the shim on `normalizeContext` (present from 0.86.0). Leave `peerRange` `>=0.80.1 <0.85.0` and `latest` `0.84.2` until the 0.84.4–0.99.2 matrix is green. Then set `compatibility/pi-versions.json` to `peerRange` `>=0.80.1 <1.1.0`, `latest` `1.0.0`, `unsupported.upper` `1.1.0`. `package.json` peers follow that range; devDependencies become exact `1.0.0`. `scripts/verify-compatibility.js` reads the policy (peers, devDeps, lockfile, pack, CI matrix = minimum + latest) and needs no logic change. CI (`.github/workflows/ci.yml`) will run 0.80.1 and 1.0.0. Also pack-test 0.86.0, where the transcript break landed. Update the README compatibility paragraphs in that same change.

STATUS: COMPLETE

## Claude resolutions
- [BLOCKER] Compat `streamSimple` does not fold a plain Context: accepted. Your guarded `toDelegateContext` goes in as C1 with a regression test (I'll cast through `unknown` for the namespace lookup).
- [MAJOR] grok-4.3 `minimal`: accepted (C2). Logged-in catalogs already produce no `minimal` for 4.3, because only 4.5/4.6 alias it, so this aligns the fallback metadata with what users see.
- [MAJOR] Built-in catalog changes: accepted (C2). Our `maxTokens`/cost stay package metadata. Known metadata for `grok-4.7` is deferred.
- [MINOR] Stable API surface: noted. `toolChoice` passthrough is fine, because `exposeGrokNativeToolNames` already rewrites `tool_choice`.
- Recommendation: accepted. Minimum stays 0.80.1; `>=0.80.1 <1.1.0`, latest 1.0.0; extra candidates at 0.86.0 and 0.99.2.
