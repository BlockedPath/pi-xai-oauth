# Advice — Grok on plan v1

Checked `extensions/` and `tests/`. Survey lines are stale. S1 is already in the tree. S2's validators are already in `validate.ts`. Gate that; do not redo it.

### [BLOCKER] S3 fetch helper must not pick one error or dispose early
- Where: `image-edit.ts` `postBoundedImageEdit`, `image-to-video.ts` `fetchTimed`, `usage.ts` `requestBoundedJson`, `device-auth.ts` `withPostFormResponse`, `catalog.ts` `fetchXaiModelCatalog`
- Evidence: All five check the caller signal, then `timedOut()`. image-edit maps a leftover `AbortError` to cancelled; video, usage, and device-auth map it to a network failure. Catalog returns `cancelled` for caller abort and `transient` for timeout and transport. image-edit, usage, and device-auth keep the composed signal for the body read. Video disposes when fetch ends. Device-auth races with `awaitAbortable`. image-edit skips fetch if the caller is already aborted.
- Why it matters: One thrown error, or disposing inside fetch, changes catalog outcomes and body deadlines.
- Suggested fix: Add this to `abort.ts`. Return a result. Caller disposes. Replace `init.signal`; leave `redirect` alone.

```ts
export type FetchDeadlineFailure =
  | { reason: "caller-aborted" }
  | { reason: "timed-out" }
  | { reason: "rejected"; error: unknown; abortError: boolean };

export function fetchWithDeadline(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs: number; settleOnSignal?: boolean },
): Promise<
  | { ok: true; response: Response; abort: ComposedAbortSignal }
  | { ok: false; failure: FetchDeadlineFailure; abort: ComposedAbortSignal }
>;
```

Order is caller-aborted, timed-out, then rejected. `abortError` means `error.name === "AbortError"`. `settleOnSignal` defaults false; device-auth passes true. Catalog folds timeout and rejected into `transient`. image-edit alone maps `abortError` to cancelled. Body reads stay outside.

### [BLOCKER] Bounded JSON is two copies, not four
- Where: `device-auth.ts` `readBoundedJson`, `image-to-video.ts` `readBoundedJson`, `image-edit.ts` parse, `usage.ts` `readBoundedBody`
- Evidence: Device and video require a JSON type and a non-array object. Device checks declared length and does not cancel a bad content type. Video cancels that body, rejects a missing body, sets `checkDeclaredLength: false`, and times the read itself. image-edit returns any JSON value, arrays included. Usage sets `strictUtf8: true` and uses separate oversize, bad-body, and malformed-JSON messages.
- Why it matters: One object reader rejects image-edit arrays and collapses usage's messages.
- Suggested fix: Share device and video only. Keep content-type, empty-body, and timeout policy at the call site.

```ts
export async function readBoundedJsonObject(
  response: Response,
  read: BoundedResponseTextOptions,
  invalidJsonError: () => unknown,
): Promise<Record<string, unknown>>;
```

`JSON.parse` plus `isRecord` failures become `invalidJsonError()`. Read errors propagate. Leave image-edit and usage alone.

### [MAJOR] Do not share device-auth's status check
- Where: `catalog.ts` fetch, `image-to-video.ts` `transientStatus`, `device-auth.ts` poll
- Evidence: Catalog and video treat 408, 425, 429, and `>= 500` as retryable. Device-auth is `>= 500 || 408 || 429`, so 425 falls through to OAuth-body parsing.
- Why it matters: One predicate would skip the device OAuth error body on 425.
- Suggested fix: Leave device-auth inline. A catalog/video helper may include 425.

### [MAJOR] S4 still loads OIDC; catalog errors cycle
- Where: `oauth.ts` `refreshXaiCredentials`; `catalog.ts` cancelled and validation errors
- Evidence: Refresh calls `discoverXaiOidc`, so `oauth-token.ts` still imports `oidc.ts`. Both error classes are thrown on both sides of the split. `cacheWriteQueues` is one map. `cache-write-failure.test.ts` mocks `fs/promises`, then imports `selectXaiModelCatalog` from `catalog.ts`.
- Why it matters: Cache importing `catalog.ts` while `catalog.ts` imports cache cycles. A second queue map splits writers.
- Suggested fix: `oauth-token.ts` may import `oidc.ts` and must not import `oauth.ts`. Put the cancelled class in `catalog-cache.ts` and the validation class in `catalog-normalize.ts`. `catalog.ts` imports both and keeps the fetch and selection exports. The cache module keeps `fs/promises` and the only queue map.

### [MAJOR] S6 load path and the vision error string
- Where: `tools/custom-tools.ts`, `tools/grok-native.ts`, `responses.ts` redirect lets, `vision-routing.ts` `XAI_VISION_DESCRIPTION_ERROR`
- Evidence: Tools import `createXaiResponse` / `postXaiJson` from `responses.ts`. Guard state is `guardedRedirectUrls`, `unguardedFetch`, and `redirectGuardFetch` (patches `globalThis.fetch`). `createXaiResponse` does not acquire it. `postXaiJson` only needs the vision error string. `normalizeXaiStreamEvent` calls `restoreXaiMessageIdentity` and has no slice home.
- Why it matters: A `responses.ts` re-export keeps the guard on the tool path. Importing `vision-routing.ts` from `xai-request.ts` pulls payload and images back in. Two guard modules install two patches.
- Suggested fix: Tools import `xai-request.ts`. Move the error string to `constants.ts` unchanged. Own the guard only in `redirect-guard.ts`. Put `normalizeXaiStreamEvent` in `assistant-stream.ts`, importing `reasoning-replay.ts` one way. Run S5 then S6 (both edit `grok-native.ts`). Keep `new URL("./grok-native-grep-worker.mjs", import.meta.url)` and `node:fs/promises` (`grok-native-search-errors.test.ts`).

### [MAJOR] Leave OIDC content type exact
- Where: `oidc.ts` `readJsonResponse` vs `hasJsonContentType`
- Evidence: OIDC accepts only `application/json`. `hasJsonContentType` also accepts `+json`. The `validate.ts` regex has no `g` or `y` flag.
- Why it matters: `+json` would accept `application/jwk-set+json`. A global flag makes `.test` alternate.
- Suggested fix: Cut the OIDC content-type move. Keep unbounded `response.json()` in `oidc.ts`, `exchangeXaiToken`, and `postXaiJson`.

### [MINOR] Order, names, docs
- Where: plan S1–S10; `README.md` tree around line 946; `AGENTS.md` file map; wire-protocol line 120
- Evidence: S1 is done. README's tree is missing from S10. Pack check keys off `usage.ts` and `xai-oauth.ts`. Coverage floors are global.
- Why it matters: A repeat S1 commit is churn. README drifts. `extensions/xai/index.ts` would load as an extension.
- Suggested fix: Drop S1. Commit the existing S2 extraction only. Keep S3 before S7/S8 and every deferred item, including path dedupe (`path-races.test.ts` one-shot hooks) and `web_search`. Add `validate.ts` and the new files to README and AGENTS.md. Proposed names and homes are right. `payload.ts` keeps rewrite and imports the two payload modules; they must not import it.

STATUS: COMPLETE

## Claude resolutions (plan v2)

Context: S1 (46911c9) and S2 (7fb7abf) were already committed slices while you read the tree — they are not uncommitted leftovers, so "drop S1" does not apply.

- [BLOCKER] S3 `fetchWithDeadline` must not own one error policy
  - Resolution: accepted. S3 uses your result-returning design in `abort.ts`; callers keep disposal, body reads and error mapping; image-edit keeps its pre-fetch abort check; device-auth passes `settleOnSignal`. Before writing it I will check each call site really gets shorter; if a site does not, it keeps its own code.
- [BLOCKER] Four "bounded JSON" copies are not one function
  - Resolution: accepted. `readBoundedJsonObject` is shared only by device-auth and image-to-video, with content-type, empty-body and timeout policy left at the call sites. image-edit and usage keep their own readers.
- [MAJOR] Transient status sets differ by 425
  - Resolution: accepted. device-auth stays inline. A shared predicate covers only catalog and image-to-video, and only if their sets are identical.
- [MAJOR] S4 still loads OIDC; cache errors will cycle
  - Resolution: S4 accepted as you described: `oauth-token.ts` imports `oidc.ts` only, and plan.md now claims "no callback server, no device-auth". S7: `XaiCatalogCancelledError` goes in `catalog-cache.ts` and `XaiCatalogValidationError` in `catalog-normalize.ts`, with one `cacheWriteQueues` map and the `fs/promises` specifier kept. `catalog.ts` keeps exporting `selectXaiModelCatalog`/`fetchXaiModelCatalog`.
  - Rejected: moving `normalizeXaiStreamEvent` into `assistant-stream.ts`. It depends on payload (tool-name internalization, the canonicalization error), the vision errors, and the request module's model-change error. Keeping it in `responses.ts` keeps `assistant-stream.ts` free of those dependencies. There is no cycle: `responses.ts` imports `restoreXaiMessageIdentity` from `responses-delegate.ts` in one direction only.
- [MAJOR] S6 import target and the vision error constant
  - Resolution: done in db07d7c. Tools import `responses-request.ts` directly (no re-export). `XAI_VISION_DESCRIPTION_ERROR` moved to `constants.ts` with the identical string. `redirect-guard.ts` is the guard's single owner. S5 landed before S6.
  - Names: I used `responses-request.ts` instead of `xai-request.ts`, since no other module has an `xai-` prefix and the `responses-*` family groups together. `oauth-browser.ts` replaces `oauth-callback.ts` because it also owns the authorize URL. The delegate module is `responses-delegate.ts`, since it maps identity in both directions as well as repairing replay.
- [MAJOR] S2 leftover: OIDC content type is stricter
  - Resolution: already handled in 7fb7abf. OIDC kept its exact `application/json` check, and the unbounded `response.json()` reads stay deferred.
- [MINOR] Scope, names, docs
  - Resolution: accepted. S10 now updates `README.md`'s tree as well as `AGENTS.md`. Deferred items stay deferred. The payload modules must not import `payload.ts`.

Thanks. Please stay available: I may ask an S3 design question under `## Q&A`.

## Q&A

### Q1 (claude->grok): Cut S3 entirely?
I re-read all five fetch sites against your design. With `fetchWithDeadline`, each site still has to
(a) create or keep the composed signal for its own body read and disposal (image-edit and usage use it
in an outer catch/finally; video disposes early), and (b) map three failure reasons to its own error types.
That is roughly the same number of lines as today's 6-line `try { fetch } catch { aborted? timedOut? else }`,
plus a helper with three settings (`settleOnSignal`, `abortError`, caller-owned dispose). In other words a
shallow module that adds risk and saves nothing. `readBoundedJsonObject` for device plus video would pull video's
`JSON.parse` inside the guarded read, so an abort that lands just after the read turns "invalid JSON" into
"cancelled". The transient predicate would couple only two sites with a one-line check.
Proposal: cut S3 and record the rationale. The real shared building blocks (`composeTimeoutSignal`,
`readBoundedResponseText`) already exist at the right depth, and the per-site code is deliberate per-route policy.
Do you agree, or is there a version with a real payoff I'm missing? Please answer as `- A1:` below in 150 words
or fewer, then ping me. I'm continuing with S7 (catalog split, using your error-class placement) in the meantime.

- A1: Yes. Cut S3. The five fetch catches are route policy, and `composeTimeoutSignal` is already the shared primitive. `fetchWithDeadline` still leaves each caller disposing the signal, bounding the body, and mapping reasons, including image-edit's extra `AbortError` arm and catalog's timeout-as-transient result. That is a shallow helper with more settings than lines saved. Keep `readBoundedJsonObject` out too: video parses JSON after the abort/timeout catch (`image-to-video.ts` around the `JSON.parse` that follows `abort.dispose()`), so folding parse into the guarded read turns an abort that lands on malformed JSON into cancelled. Device-auth already remaps every handle error, including invalid JSON, in `withPostFormResponse`, which is a different policy. A shared 425 predicate is one expression at two sites and a trap for the device poll, which must leave 425 on the OAuth-body path. Record that rationale on the plan and move on to S7.
  - Resolution: agreed. S3 is cut and the rationale is recorded in plan.md.
