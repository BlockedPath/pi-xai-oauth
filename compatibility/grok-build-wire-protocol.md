# Grok Build wire-protocol compatibility

This document records the xAI request contract reviewed for issue [#78](https://github.com/BlockedPath/pi-xai-oauth/issues/78). It is a compatibility audit, not a claim that `pi-xai-oauth` is the official Grok client.

## Last reviewed upstream revision

- Repository: `xai-org/grok-build`
- Commit: `b189869b7755d2b482969acf6c92da3ecfeffd36`
- Upstream commit date: 2026-07-15
- Local implementation: `extensions/xai/wire.ts`

Pinned source starting points:

- [Per-request identity headers](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-sampler/src/client.rs#L35-L76)
- [Default auth, client, version, and User-Agent headers](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-sampler/src/client.rs#L399-L496)
- [Proxy-specific injected headers](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs#L1148-L1190)
- [Responses defaults and dispatch](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-sampler/src/client.rs#L1081-L1160)
- [Subscription billing structures and handler](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-shell/src/extensions/billing.rs#L1-L288)

The upstream sampler posts paths relative to a configured base URL. That does not authorize this package to accept caller-, model-, or catalog-provided origins. The endpoint policy below remains pinned in source.

## Identity and version policy

These values have separate meanings and must not be conflated:

| Value | Local policy |
| --- | --- |
| `x-grok-client-identifier` | Always the truthful npm package name, `pi-xai-oauth`. |
| `User-Agent` | Always `pi-xai-oauth/<package version>`. |
| `x-grok-client-version` | The installed `pi-xai-oauth` package version. It is the only truthful controlled version available to this third-party client. |
| Reviewed Grok Build revision | Stored separately as the commit above. It is documentation/audit metadata and is not sent as product identity. |

The reviewed source treats `x-grok-client-version` as a proxy gate input, but it does not define an authoritative third-party protocol-version value. This package therefore does not copy a `grok-shell`, crate, or official binary version merely to pass a server gate. A gate rejection produces an actionable status-only error asking the user to update this package or open a compatibility issue.

## Pinned route and header matrix

All listed headers are internally owned. Caller/model headers are scrubbed case-insensitively before the route contract is appended.

| Request | Pinned route | Required contract | Explicit exclusions |
| --- | --- | --- | --- |
| Browser authorization | `https://auth.x.ai/oauth2/authorize` | PKCE S256, state, nonce, pinned client ID/scopes/redirect | No bearer or CLI-proxy headers |
| Device initiation | `https://auth.x.ai/oauth2/device/code` | JSON accept, form content type, truthful User-Agent, client version/surface | No bearer or CLI-proxy headers |
| Browser/device/refresh token | `https://auth.x.ai/oauth2/token` | JSON accept, form content type, truthful User-Agent, client version/surface | No CLI-proxy headers; no response-body reflection |
| OIDC discovery/JWKS | Pinned issuer discovery and JWKS URLs | JSON accept, redirect rejection, issuer/algorithm/key validation | No bearer, caller endpoint, or proxy metadata |
| OAuth model catalog | `https://cli-chat-proxy.grok.com/v1/models-v2` | Bearer, JSON accept, truthful identity/version/User-Agent, token-auth, authenticate-response, client mode | No conversation, request, model, session, agent, turn, user, or deployment IDs |
| OAuth account identity | `https://cli-chat-proxy.grok.com/v1/user` | Pi-stored OAuth bearer, token-auth, client version/mode, redirect rejection, 15-second timeout, 64 KiB response bound | No `x-userid`, API-key provenance, caller endpoint, or caller/model headers |
| OAuth subscription usage | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` | Same verified OAuth bearer plus the immediately preceding bounded `/user` result as transient `x-userid`; redirect/timeout/body/JSON bounds | No cached/persisted identity, API-key provenance, caller endpoint, or other identity/affinity IDs |
| OAuth streaming Responses | `https://cli-chat-proxy.grok.com/v1/responses` | Bearer, JSON content, `Accept: text/event-stream`, truthful identity/version/User-Agent, proxy auth, client mode, conversation/request/model/session metadata, redirect rejection | No unsupported identity IDs, generic SDK affinity IDs, or caller route |
| OAuth direct Responses | `https://cli-chat-proxy.grok.com/v1/responses` | Same proxy metadata with `Accept: application/json` and redirect rejection | No SSE accept, unsupported identity IDs, or generic SDK affinity IDs |
| API-key direct Responses | `https://api.x.ai/v1/responses` | Bearer, JSON accept/content, truthful User-Agent, redirect rejection | No CLI-proxy metadata or generic SDK affinity IDs |
| OAuth or API-key image generation | `https://api.x.ai/v1/images/generations` | Bearer, JSON accept/content, truthful User-Agent, redirect rejection | No CLI-proxy metadata |
| OAuth or API-key video create | `https://api.x.ai/v1/videos/generations` | Bearer, JSON accept/content, truthful User-Agent, 60-second timeout, bounded response, redirect rejection | No CLI-proxy metadata or retries |
| OAuth or API-key video status | `https://api.x.ai/v1/videos/<validated-request-id>` | Bearer, JSON accept, truthful User-Agent, fixed 5-second polling, per-request/cumulative bounds | No content type, CLI-proxy metadata, caller URL, or unvalidated path input |
| Temporary video download | Authenticated status response's validated HTTPS URL | No-auth GET, resolve-once public DNS/IP pinning, TLS hostname verification, redirect rejection, MP4 MIME/evidence, 256 MiB streamed bound | No bearer, cookie, proxy, caller, or xAI affinity headers; URL/query never reflected |

### Header classification

- Always internally owned: `Authorization`, `Accept`, `Content-Type`, `User-Agent`, every `x-grok-*` header, `X-XAI-Token-Auth`, `x-authenticateresponse`, and `x-userid`.
- Proxy-route authentication: `X-XAI-Token-Auth: xai-grok-cli` and `x-authenticateresponse: authenticate-response`.
- Truthful attribution/gating: `x-grok-client-identifier`, `x-grok-client-version`, and `User-Agent`.
- Route mode: `x-grok-client-mode`, resolved as `interactive` only for a text TTY and `headless` for print/JSON/RPC/non-TTY operation.
- Streaming only: `Accept: text/event-stream`.
- Usage billing only: `x-userid`, accepted only from the bounded authenticated `/user` response and never from caller/model headers.
- Affinity/routing metadata: conversation, request, model override, and session IDs on OAuth Responses only.
- Unsupported outside the pinned billing request: agent, turn, deployment, and user IDs. Unknown caller-supplied `x-grok-*` names are rejected. Generic delegate affinity headers (`session_id`, `x-client-request-id`, and `x-session-id`) are suppressed so only the reviewed xAI conversation/request/session fields leave the process.

## ID ownership

- Normal Pi streams use Pi's `sessionId` as both `x-grok-conv-id` and `x-grok-session-id`.
- If Pi supplies no session ID, the extension generates one UUID and uses it for both affinity fields.
- Direct Responses helpers generate one UUID per helper request for conversation/session affinity.
- Every actual Responses HTTP attempt gets a fresh `x-grok-req-id` UUID.
- `x-grok-model-override` comes only from the normalized selected/requested model ID.
- `x-grok-agent-id` is omitted because upstream treats it as a persistent runtime/machine identity and Pi does not provide an equivalent consented value.
- `x-grok-turn-idx` is omitted because Pi does not expose one authoritative value through all streaming and direct helper paths.
- Subscription usage obtains `x-userid` only from the pinned authenticated `/user` lookup, uses it once for the immediately following billing request, and discards it.
- Deployment and other user IDs are never derived from OAuth credentials, identity tokens, catalog bodies, or local machine state.

## Privacy and failure policy

The header sanitizer removes authorization, accept/content type, User-Agent, proxy auth, `x-userid`, generic SDK affinity IDs, and every caller-provided `x-grok-*` value before adding the approved route contract. This prevents client impersonation and privacy-sensitive ID injection while preserving unrelated non-reserved headers. The usage module alone adds its transient validated `x-userid` to the pinned billing GET. Responses, media POSTs, and usage GETs reject redirects before fetch can replay request bodies or metadata to another origin.

Unsuccessful direct HTTP responses are read through a 16 KiB bound for classification only. Raw response bodies, request headers, credentials, and request bodies are never included in the thrown/displayed message. Errors preserve HTTP status and route classification. Proxy version-gate signals return stable update/report guidance and the last reviewed revision; they do not recommend copying an official Grok version.

Catalog, OAuth, OIDC, and device paths retain their existing stricter endpoint, response-size, cancellation, and secret-redaction rules.

## Encrypted reasoning boundary (#79)

Issue [#79](https://github.com/BlockedPath/pi-xai-oauth/issues/79) implements the reviewed contract on the pinned OAuth streaming and direct Responses routes:

- absent `store` defaults to `false`, while an explicit value is preserved;
- final `include` retains compatible string entries in first-occurrence order and contains `reasoning.encrypted_content` exactly once, even after caller payload hooks;
- complete completed reasoning items, including encrypted-only and additive fields, use Pi's opaque `thinkingSignature` carrier and replay inline at their original conversation position;
- active, uncompacted multi-turn input keeps a stable serialized prefix;
- Pi permits replay only when provider, API, and exact model match, and omits failed or aborted assistant turns;
- API-key direct Responses, media, catalog, usage, auth, and non-Responses routes do not receive this package policy;
- a proxy HTTP 400 containing the narrow `encrypted_content` marker, or an HTTP-200 SSE `response.failed` carrying both `invalid_request` and that marker, produces fixed clean-session/model guidance, is redacted, and is not automatically retried;
- after that fixed failure is retained in same-model history, the next request omits encrypted reasoning items from the rejected chain while preserving visible messages, function calls, tool results, and the `store:false` / encrypted-include policy; unrelated failures do not activate this omission.

Encrypted content is ordinary local Pi session state. `store:false` disables server-side response storage but does not prevent Pi from writing the complete item to its session JSONL under normal permissions and retention. This package does not separately encrypt, duplicate, inspect, render, or log it. Compaction may intentionally replace older active context, and trusted local extensions or users with file access can inspect session state.

Pi's delegated SSE error shape does not preserve an HTTP status for failures that arrive after a successful stream connection. The stream classifier is therefore separately bounded to a terminal `response.failed` result whose redacted delegate text contains both xAI's `invalid_request` code and the `encrypted_content` marker. Other streamed failures remain generic and redacted, and numeric status/retry wording is preserved when the delegate supplies it.

## Repeatable upstream review procedure

1. Select an immutable Grok Build commit; never review a moving branch label.
2. Fetch the relevant files at that exact revision:

   ```bash
   REV=b189869b7755d2b482969acf6c92da3ecfeffd36
   gh api -H 'Accept: application/vnd.github.raw+json' \
     "repos/xai-org/grok-build/contents/crates/codegen/xai-grok-sampler/src/client.rs?ref=$REV"
   gh api -H 'Accept: application/vnd.github.raw+json' \
     "repos/xai-org/grok-build/contents/crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs?ref=$REV"
   gh api -H 'Accept: application/vnd.github.raw+json' \
     "repos/xai-org/grok-build/contents/crates/codegen/xai-grok-sampling-types/src/conversation.rs?ref=$REV"
   ```

3. Reclassify every changed header as internally required, route-specific, streaming-only, affinity, optional attribution, or unsupported. Trace where upstream values originate; do not assume the sampler generates IDs it only forwards.
4. Re-audit `extensions/xai/constants.ts`, `routing.ts`, `wire.ts`, `responses.ts`, `catalog.ts`, `usage.ts`, `oauth.ts`, and `device-auth.ts`. Preserve pinned origins unless a separate security review explicitly changes them.
5. Update the reviewed revision and this matrix only after request-shape/privacy tests cover the new behavior.
6. Run:

   ```bash
   npm run test:unit -- tests/responses/routing.test.ts tests/catalog/cache.test.ts tests/usage tests/oauth/browser-login.test.ts tests/oauth/refresh.test.ts tests/oauth/device-initiation.test.ts tests/oauth/device-polling.test.ts
   npm run typecheck
   npm test
   npm run compatibility:boundaries
   ```

7. Record any encrypted-reasoning change in #79 rather than folding it into an unrelated header review.
