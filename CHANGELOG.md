# Changelog

All notable user-facing changes to `pi-xai-oauth` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

Dates below are npm publication dates. The earliest rapid-release series is grouped where the repository did not preserve reliable per-version release notes.

## Unreleased

### Fixed

- Classified encrypted-reasoning mismatches delivered through HTTP-200 `response.failed` streams, kept their details redacted and non-retryable, and made the next same-model turn recover by omitting only the rejected encrypted reasoning while preserving visible messages and tool results. Canonical and persisted delegate-tagged xAI history now follow the same replay and cross-model protections.

## 1.5.0 - 2026-08-12

### Added

- Added known-model metadata and catalog support for Grok 4.6 (`grok-4.6`), including text+image input, 500K context, official standard-tier pricing, and authenticated reasoning levels `low` / `medium` / `high` / `xhigh`.
- Mapped Pi's `minimal` thinking level onto xAI `low` for Grok 4.6 (same compatibility behavior as Grok 4.5).

### Changed

- Promoted `grok-4.6` to the package default model and curated offline fallback used by setup, request helpers, and permanent catalog-failure paths. Grok 4.5 remains fully supported when the authenticated catalog entitles it.

### Documentation

- Documented Grok 4.6 as the flagship default, kept Grok 4.5 as an entitled catalog model, and noted Grok 4.6's additional `xhigh` reasoning level.

## 1.4.2 - 2026-08-09

### Added

- Added an `@blockedpath/pi-xai-oauth` GitHub Packages mirror alongside the canonical `pi-xai-oauth` npmjs package. GitHub Release publishing now validates once and publishes the same release contents to both registries with registry-specific authentication; after the first publication, a package administrator can make the mirror public in GitHub's package settings.
- Added a deterministic mirror-packaging verifier that rewrites only the distribution name and registry, preserves the exact version, repository, peer range, and package contents, and runs in CI and release validation.

### Changed

- Made the setup CLI distribution-aware so npmjs, GitHub Packages, and local installs are treated as aliases of one extension; setup preserves the selected registry and removes duplicate aliases before they can register conflicting tools.
- Made both registry publish steps idempotent so a retry can finish a partially successful release without attempting to overwrite an immutable package version.

## 1.4.1 - 2026-08-09

### Changed

- Setup no longer forces `defaultProvider: xai-auth`. When no provider is configured it seeds Pi's built-in `xai` chat provider, preserves any existing provider choice (including package-owned `xai-auth`), and still installs opt-in tools plus `/xai-usage` for both providers.
- Reviewed Pi 0.82 through 0.84.1 and adopted 0.84.1 as the latest exact tested boundary after clean packed candidate validation, while preserving the 0.80.1 minimum. Compatibility coverage now includes Pi 0.83's proactive OAuth refresh and Pi 0.84's cross-process credential reload, abortable refresh, and generation-checked catalog publication contracts.
- Widened aligned Pi peers to `>=0.80.1 <0.85.0` and pinned development metadata and the lockfile exactly to 0.84.1, the latest release inside the allowed line at review time. Pi 0.82's `bash` session metadata remains suppressed from Grok-native terminal children through the cross-range `spawnHook`.
- Audited Pi's built-in `xai` reasoning levels against the package-owned `xai-auth` catalog and found no stale mappings; every difference is intentional and is now pinned by tests. No advertised reasoning level changed.
- Suppressed Pi's `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` metadata from Grok-native terminal child processes, including stale parent values on older supported Pi versions, while preserving all unrelated environment variables and standard shell behavior.

### Fixed

- Forwarded Pi 0.84's concrete OAuth refresh abort signal through xAI discovery and token exchange so cancelled or timed-out refreshes release Pi's credential-store lock without a late network commit.
- Kept real-runtime credential cancellation and model-catalog publication tests compatible with both the Pi 0.80.1 legacy surfaces and Pi 0.84's abort and read-only stored-catalog contracts.

### Documentation

- Documented the intentional reasoning-level differences between Pi's built-in `xai` provider and package-owned `xai-auth`, including the Grok 4.5 `minimal` → xAI `low` mapping, identical Grok 4.3 levels, and the never-advertised API-key-only `grok-build-0.1`.
- Recorded the evidence-based decision to keep Pi 0.82 constrained JSON-schema sampling disabled for package custom tools until the pinned xAI OAuth Responses route has route-specific strict-tool support evidence; no runtime capability flag or catalog metadata was added.

## 1.4.0 - 2026-07-23

### Added

- Added disabled-by-default, session-scoped vision routing for exact authenticated text-only entitlements, with deterministic exact-catalog target selection, a bounded image-only description request, final image-free enforcement, lifecycle invalidation, and `/xai-tools` cost/privacy controls.
- Added the listener-owned, versioned `pi-clickable-menu:xai-tools` bridge contract, covering its canonical channel, request shape, action timing, and honest result semantics.
- Added disabled-by-default `xai_image_to_video` with pinned create/status polling, DNS-pinned unauthenticated MP4 download, bounded streamed private storage, and honest remote-job cancellation semantics.
- Added ModelRuntime re-registration coverage, a store-backed models-store precedence regression (discard stale overlays when the local catalog is newer), and request-auth tests that prefer `ModelRuntime.getAuth` over the legacy `getApiKeyAndHeaders` projection.
- Added opt-in network-tool and OAuth-only usage support for Pi's built-in `xai` provider, with active-provider credential preference, subscription/API-key provenance routing, and explicit isolation from package-owned catalog, stream, vision, and local-adapter behavior.

### Changed

- Recorded the package-scope decision to keep provider-neutral goal/plan workflows, autonomous continuation, runtime plan management, and write-restriction policy out of `pi-xai-oauth`; see [ADR 0001](docs/decisions/0001-goal-plan-package-scope.md).
- Reviewed Pi 0.80.8 through 0.81.0 and adopted 0.81.0 as the latest exact tested boundary after clean packed candidate validation, while preserving the 0.80.1 minimum.
- Reviewed Pi 0.81.1 and adopted it as the latest exact tested boundary after clean packed candidate validation, while preserving the 0.80.1 minimum and `>=0.80.1 <0.82.0` peer range.
- Widened aligned Pi peers to `>=0.80.1 <0.82.0` and pinned development metadata exactly to 0.81.1.
- Migrated extension request-auth resolution to prefer `ModelRuntime.getAuth` when the host exposes it, then the ModelRegistry `getApiKeyAndHeaders` / `getProviderAuth` projections for older supported boundaries.
- Deferred adopting Pi's `refreshModels(context)` provider hook: account-bound `/models-v2` discovery still needs login-generation tracking, force-refresh after credential switch, and package-owned token-free cache TTL/stale policy that the generic hook does not replace.

### Fixed

- Fixed the `pi-clickable-menu:xai-tools` bridge so malformed action, tool, and command-context fields are rejected before dispatch and every request with a callable `done` receives exactly one result.
- Fixed the `pi-clickable-menu:xai-tools` bridge so `status`, `enable`, and `disable` return the shared command handler's actual success or failure instead of acknowledging toast-only failures as successful.
- Fixed the `pi-clickable-menu:xai-tools` bridge so `action: "open"` acknowledges `done` when the interactive picker is accepted for launch, instead of waiting until the picker closes (avoids the menu host's ~4s false timeout).
- Consolidated duplicate `xai_web_search` and Grok-native `web_search` registrations into one collision-safe, opt-in `web_search` picker entry. The old `xai_web_search` command spelling remains an input-only compatibility alias, and the public name is still never registered globally.
- Contained the direct Grok-native `read_file`, `search_replace`, and `list_dir` adapters to resolved workspace paths, safely limited missing-leaf creation to contained physical parents, and capped package-owned full text reads at 5,000,000 bytes. `run_terminal_command` remains an unrestricted delegation to pi `bash`, so this is direct-adapter defense-in-depth rather than a filesystem sandbox.
- Restricted legacy local PNG/JPEG inputs across custom tools, Responses payload normalization, and vision routing to byte-bounded, byte-validated regular files inside the active workspace, with sanitized failures for traversal, outward symlinks, special files, MIME spoofing, oversized sources, and pixel bombs.
- Fixed opt-in vision routing so enabled sessions advertise image input only to Pi's delegated Responses converter, retain truthful text-only metadata elsewhere, recursively strip nested historical image and screenshot shapes, reapply consumed-history pruning after caller payload hooks, route only current unconsumed user/tool images, and bind each request to its original reset-sensitive authorization grant.
- Kept vision-routed images available across mid tool-loop turns so multi-step image work does not drop the original user/tool image after the first model hop.
- Pinned managed credential lookup for network tools and `/xai-usage` to the active xAI-compatible provider (`xai` or `xai-auth`) instead of falling through to a sibling provider's stored credentials, and derived `catalogScope: "host"` from the credential's provider id.
- Pinned public IPv4 resolution for dual-stack xAI video downloads so IPv6-only download hosts fail closed.
- Handled empty web-search responses without treating a successful empty result set as a transport failure.

## 1.3.6 - 2026-07-18

### Added

- Added encrypted reasoning replay on the pinned OAuth Responses route, including final `store:false` defaults, deduplicated encrypted-content requests, complete inline typed-item persistence/replay, exact provider/API/model isolation, and fixed redacted mismatch guidance.
- Added a revision-pinned Grok Build wire-protocol matrix, ID-ownership policy, repeatable upstream review procedure, and an explicit encrypted-reasoning handoff to issue #79.
- Added deterministic streaming/direct Responses, catalog, OAuth form, client-mode, media-boundary, reserved-header, bounded-error, and proxy version-gate request-shape coverage.
- Added bounded authenticated `acceptsImages` / `inputModalities` normalization with explicit input-capability provenance and redacted schema fixtures.
- Added focused typed Vitest regressions across provider/catalog routing, browser/device OAuth and OIDC, Responses payloads/streams/errors, images, network-tool lifecycle, custom tools, Cursor shims, and setup/settings.
- Added the disabled-by-default `xai_edit_image` tool with exact singular/plural Imagine edit payloads, a distinct pinned `/images/edits` route, timeout/cancellation, and redacted errors.
- Added reusable bounded media primitives for byte-validated PNG/JPEG data URLs and workspace files, source-backed compression, explicit request/response/output budgets, and atomic 0700/0600 Pi-session storage.
- Added the explicit `/xai-usage` command with pinned authenticated `/user` identity resolution followed by the unofficial revision-pinned `/billing?format=credits` lookup.
- Added an optional session-only compact usage status that is off by default, refreshes no more than once per minute after completed xAI turns, and clears on model, provider, account, and session changes.
- Added fixture-based usage parser, transport, cancellation, redaction, command, bounds, and status-lifecycle coverage.
- Added a small real Pi extension-loader smoke plus V8 text/JSON/LCOV coverage with measured regression floors.
- Added a browser-first native login-method selector with device authorization for SSH, WSL, containers, remote workspaces/VMs, and human-operated headless sessions.
- Added pinned, bounded, cancellable RFC 8628 polling with initial wait, server interval plus cumulative `slow_down`, denial/expiry handling, strict secret-safe schema validation, and deterministic timing tests.
- Added authenticated OAuth-visible model discovery from the official CLI proxy `/models-v2` endpoint.
- Added defensive model normalization plus an atomic, token-free last-known-good cache with a 15-minute fresh TTL, a 5-second bounded refresh, and a 7-day stale-if-transient window.
- Added fixture-based coverage for catalog additions, removals, empty entitlements, malformed entries, API-key-only filtering, cache freshness, auth/network failures, and curated fallback selection.
- Added packed-package compatibility validation at exact Pi 0.80.1 and 0.80.10 boundaries, with requested/resolved version reporting, range and registry-drift checks, packed-manifest inspection, and unsupported-peer install diagnostics.
- Added PR/main CI that derives its exact compatibility matrix from the checked-in Pi version policy instead of reusing the development lockfile version.

### Changed

- Centralized xAI wire headers around pinned routes, truthful `pi-xai-oauth/<version>` attribution, package-controlled proxy versioning, and shared OAuth form metadata.
- Migrated the normalized model cache to schema 2 while safely retaining schema-1 membership and rederiving legacy input as known/default rather than authenticated evidence.
- Bounded the unofficial usage transport to pinned endpoints, rejected redirects, 15-second request timeouts, 64 KiB bodies, bounded JSON complexity/history, and conservative numeric/timestamp ranges.
- Replaced the shared-state monolithic behavior verifiers with isolated per-domain suites and closure-local fixtures; production runtime behavior is unchanged.
- Made the repository CI job run the full unit suite once under coverage and the loader smoke separately; packed compatibility jobs rerun unit, loader, and TypeScript checks at each exact Pi boundary.
- Centralized xAI endpoint selection around explicit OAuth-session versus API-key credential provenance instead of model IDs.
- Kept Grok Build and Composer payload, header, and tool compatibility separate from transport routing.
- Updated fresh OAuth logins to request xAI's current eight-scope Grok client grant, including conversation read/write access, while leaving existing refresh grants compatible.
- Derived the proxy client identifier and version from this package's own metadata instead of impersonating a stale Grok CLI release.
- Made the authenticated account catalog authoritative for OAuth model additions and removals; known static metadata now enriches returned IDs without advertising unreturned models.
- Made successful login force-refresh and immediately replace the model catalog, while `/reload` follows the documented cache TTL.
- Kept browser authorization-code + PKCE as the desktop default while recommending device login in remote/headless selector copy without automatically changing the selected method.
- Replaced wildcard Pi peers with the aligned, bounded `>=0.80.1 <0.81.0` range and pinned development metadata exactly to the latest tested boundary, 0.80.10.
- Reviewed Pi 0.80.8 through 0.80.10 and adopted 0.80.10 after clean packed candidate validation, while preserving the 0.80.1 minimum and existing peer range.
- Documented the deliberate candidate-test and review process required before widening support to another pre-1.0 Pi line.

### Fixed

- Kept startup credential discovery compatible with Pi 0.80.1 and Pi 0.80.10 by using the new read-only `readStoredCredential()` API when available and a synchronous JSON-only fallback on older supported hosts, without creating credential storage.
- Migrated the real Pi credential-persistence integration test to exercise `ModelRuntime` and `InMemoryCredentialStore` on current Pi while retaining the legacy boundary path.
- Explicitly negotiated `text/event-stream` for streaming Responses while keeping direct Responses and media requests on JSON Accept semantics.
- Scrubbed caller/model authorization, content negotiation, User-Agent, proxy metadata, generic delegate affinity IDs, unsupported IDs, and unknown `x-grok-*` headers before applying the approved route contract.
- Rejected redirects for streaming/direct Responses and media POSTs before fetch can replay request bodies or metadata to another origin.
- Replaced raw direct-response error reflection with bounded status/route classification and actionable, non-impersonating proxy version-gate guidance.
- Prevented authenticated text-only entitlements from sending image-bearing Responses payloads, including payload-hook mutations and image-input custom tools, without changing image generation.
- Canonicalized final Responses payloads before model and modality enforcement, detected computer screenshots, disabled unsafe delegated retries, and hardened wide-payload traversal so custom serializers cannot bypass authenticated text-only policy.
- Made usage credential and identity resolution fail closed before billing, rejected stored/runtime API-key provenance, and prevented account identity, authenticated headers, raw response bodies, and transport details from being cached, persisted, logged, or reflected in errors.
- Removed the unbound raw authorization-code fallback; pasted browser completions require matching OAuth state, and raw-code users are directed to device login or a complete state-bound redirect URL.
- Pinned xAI OIDC discovery and JWKS policy and validated fresh-login ID-token ES256 signatures, signing keys, issuer, audience, expiry, and nonce before retaining credentials.
- Stopped reflecting xAI token endpoint response bodies in authentication errors.
- Routed normal streaming and separate Responses helpers for every `xai-auth` model through the official Grok CLI session-token proxy, matching the intended OAuth/session-token transport contract for Responses traffic.
- Preserved the official direct `api.x.ai` Images endpoint for OAuth-backed image generation while keeping a future explicit API-key Responses route on the public API.
- Added the complete CLI-proxy authentication, client-mode, request, conversation, session, and model metadata to every OAuth Responses request, with required values protected from caller overrides.
- Filtered hidden, malformed, unsupported-backend, secret-bearing, and known API-key-only entries such as `grok-build-0.1` from the OAuth provider catalog.
- Invalidated stale entitlement data after authentication/permanent failures and prevented a forced post-login refresh from reusing another account's stale cache.
- Prevented device authorization failures, denial, expiry, cancellation, malformed data, and missing access/refresh tokens from returning or replacing credentials; device ID tokens are not retained without browser nonce validation.

## 1.3.5 - 2026-07-15

### Changed

- Replaced the repeated `/xai-tools` TUI selector with one persistent picker.
- Added arrow and page navigation, Enter or Space toggling, and Escape-to-close controls without rebuilding the list.
- Updated TypeScript and Node.js development type dependencies.

### Fixed

- Preserved the highlighted tool and scroll position after enabling or disabling a tool.
- Kept the existing selector behavior for RPC clients.
- Tightened npm package exclusions for local development artifacts.

## 1.3.4 - 2026-07-15

### Added

- Added the package-owned `/xai-tools` command with an interactive picker plus `status`, `enable`, and `disable` arguments.
- Added category and cost-risk context for all network-backed xAI tools:
  - `xai_generate_text`
  - `xai_web_search`
  - `xai_x_search`
  - `xai_multi_agent`
  - `xai_deep_research`
  - `xai_code_execution`
  - `xai_generate_image`
  - `xai_analyze_image`
  - `xai_critique`
  - `WebSearch` for Grok Build and Composer models

### Changed

- Made every helper that sends an additional xAI request inactive by default and explicitly opt-in for the current session.
- Kept local filesystem and shell compatibility shims automatic for eligible Grok Build and Composer models because they do not make additional xAI requests.
- Reset outbound-tool activation at session start and when switching away from eligible xAI models.

### Fixed

- Isolated the xAI Responses transport from unsupported root-module assumptions.
- Blocked disabled tools before OAuth credential resolution or network access.
- Made tool-registry failures fail closed and prevented stale activation from bypassing explicit authorization.
- Fixed paid web, X, multi-agent, deep-research, and `WebSearch` gating.
- Fixed repeated screenshot and image replay in long Responses conversations.
- Added consumed-image cleanup, safe image compaction, and a 3 MiB aggregate inline-image transport budget with clear local failures.
- Normalized multimodal Responses payloads, image-bearing tool results, and active-model routing.

## 1.3.3 - 2026-07-11

### Fixed

- Routed xAI Responses streaming through pi-ai's compatibility dispatcher so pi 0.80's extension loader no longer rewrites a subpath into an invalid module path.

## 1.3.2 - 2026-07-11

### Fixed

- Added initial compatibility with the pi-ai 0.80 Responses API.
- Scoped Cursor/Grok CLI compatibility shims to eligible models so they no longer leaked into normal Grok requests.

## 1.3.1 - 2026-07-09

### Fixed

- Improved setup cleanup so duplicate local and npm installations are detected and pruned instead of causing tool-name conflicts.

## 1.3.0 - 2026-07-08

### Added

- Added Grok 4.5 with text and image input, a 500K context window, and `low`, `medium`, and `high` reasoning levels.
- Added Grok 4.5 fast mode through `low` reasoning effort on the same model ID.

### Changed

- Made Grok 4.5 the default model across provider registration, setup, and documentation.
- Added stable Responses cache and conversation identifiers for more reliable multi-turn cache reuse.
- Hardened Grep argument normalization and missing-pattern errors for Grok CLI compatibility.

## 1.2.6 - 2026-07-07

### Fixed

- Corrected xAI image-generation request parameters and rejected the unsupported `size` option locally.
- Preserved support for generating one to four images with the active xAI image model.

## 1.2.5 - 2026-06-20

### Fixed

- Refreshed the npm compatibility guidance and Node.js development type dependency.

## 1.2.4 - 2026-06-20

### Fixed

- Added the xAI API guard delegate required by pi 0.79.8+ for OpenAI Responses streaming.
- Added direct verification against pi 0.79's guarded provider path.
- Hardened OAuth wrong-state verification timeout behavior.
- Resolved repository CodeQL findings.
- Excluded agent worktrees from npm packages.

## 1.2.3 - 2026-06-04

### Fixed

- Corrected manual OAuth callback-code parsing.

## 1.2.2 - 2026-06-04

### Added

- Added Grok Build and Composer 2.5 Fast through the Grok CLI OAuth endpoint.
- Added Grok 4.20 reasoning, non-reasoning, and multi-agent model variants.
- Added Cursor/Grok CLI compatibility shims for filesystem, search, shell, todo, and native `WebSearch` tool calls.

### Changed

- Split the original monolithic extension into focused OAuth, authentication, model, payload, Responses, and tool modules.

### Fixed

- Repaired xAI OAuth provider registration, token reuse and refresh, Responses streaming, payload normalization, and custom-tool integration.
- Added automated extension verification for provider, model, tool, authentication, and streaming behavior.

## 1.2.1 - 2026-05-17

- Republished the same Git revision as 1.2.0. The repository records no source difference between these two npm versions.

## 1.2.0 - 2026-05-17

- Short-lived publishing transition superseded by 1.2.1. The npm package metadata points to the same Git revision for both versions.

## Initial series - 2026-05-16 to 2026-05-17

### 1.0.25-1.0.26

- Added OAuth-first image generation, image analysis, critique, and deep-research tools.
- Added advanced X-search filters and moved remaining custom tools to shared OAuth token resolution.
- Added provider payload sanitization, repository security policy, contribution templates, and agent scaffolding support.
- Removed an erroneous package self-dependency and cleaned npm package contents.

### 1.0.19-1.0.22

- Added the one-command installer and automatic settings configuration.
- Fixed browser-based OAuth launch and duplicate authorization URLs.
- Improved native web and X search prompting and added multimodal image input support.
- Fixed xAI image Responses payload serialization.

### 1.0.12-1.0.17

- Reworked the extension structure, completed the OAuth flow, improved tool registration, and added automatic browser opening.
- Added clean npm packaging and the first setup experience.

### 1.0.1-1.0.9

- Added Responses API transport, reuse of `~/.grok/auth.json`, device-code authentication, and refresh-token support.
- Added text generation, multi-agent research, web search, X search, and code-execution tools.
- Added initial agentic model-change behavior and expanded usage documentation.

### 0.1.0

- Initial npm release with the `xai-auth` OAuth provider, Grok 4.3, and configurable thinking levels.
