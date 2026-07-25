# pi-xai-oauth

[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/BlockedPath/pi-xai-oauth?utm_source=oss&utm_medium=github&utm_campaign=BlockedPath%2Fpi-xai-oauth&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)
[![npm version](https://img.shields.io/npm/v/pi-xai-oauth)](https://www.npmjs.com/package/pi-xai-oauth)
[![npm downloads](https://img.shields.io/npm/dm/pi-xai-oauth)](https://www.npmjs.com/package/pi-xai-oauth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/BlockedPath/pi-xai-oauth?style=social)](https://github.com/BlockedPath/pi-xai-oauth/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/BlockedPath/pi-xai-oauth/pulls)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/)
[![pi compatible](https://img.shields.io/badge/pi-Compatible-blueviolet)](https://pi.dev)

**xAI (Grok) OAuth provider for pi** — now with **Grok 4.5**, reasoning, long context, and custom xAI tools.

```bash
npx pi-xai-oauth
```

## ✨ New: Grok 4.5

| | |
|---|---|
| **Model ID** | `grok-4.5` |
| **Role** | xAI flagship for coding, agentic tasks, and knowledge work |
| **Context** | 500K tokens |
| **Input** | text + image |
| **Reasoning** | `low` / `medium` / `high` (defaults to **high**; cannot be disabled) |
| **Fast mode** | Same model with **`low`** reasoning effort — not a separate model ID |
| **Pricing** | $2 / $6 per 1M input/output · $0.50 cache read |

```bash
pi --model grok-4.5 "Ship this feature end-to-end"
pi --model grok-4.5:high "Review this architecture for failure modes"
pi --model grok-4.5:low "Quick status check"   # fast mode
```

This package adds xAI's **account-specific OAuth model catalog** to pi, with **Grok 4.5** as the offline fallback/default, proper OAuth login, automatic token refresh, and a suite of custom xAI tools (`xai_generate_text`, `web_search`, `xai_x_search`, etc.). The normalized cache remains exact; registration may additionally expose narrowly verified compatibility routes such as Grok 4.3 and Composer only while their required authenticated entitlement source is present.

> **Latest release:** `pi-xai-oauth` **1.4.0** adds opt-in vision routing, image-to-video generation, the `pi-clickable-menu:xai-tools` bridge, built-in SuperGrok network-tool/usage support, and Pi 0.81.1 compatibility, while hardening credential isolation, local media bounds, and Grok-native path containment. Existing npm installs should run `pi update npm:pi-xai-oauth`; local checkout installs should keep only one copy with `pi remove npm:pi-xai-oauth && pi install .`.
>
> **Compatibility:** aligned `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` versions `>=0.80.1 <0.83.0`. The exact tested boundaries are 0.80.1 and 0.82.1.

See [CHANGELOG.md](CHANGELOG.md) for the complete version-by-version feature and fix history.

---

## Table of Contents

- [✨ New: Grok 4.5](#-new-grok-45)
- [Features](#features)
- [Package Scope](#package-scope)
- [Changelog](CHANGELOG.md)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Pi Compatibility](#pi-compatibility)
- [Authentication](#authentication)
- [Usage](#usage)
  - [Subscription usage (unofficial)](#subscription-usage-unofficial)
  - [Switching Models](#switching-models)
  - [Reasoning / Thinking Levels](#reasoning--thinking-levels)
- [Custom Tools](#custom-tools)
- [Quick Reference](#quick-reference)
- [Troubleshooting](#troubleshooting)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Agent Scaffolding](#agent-scaffolding)
- [Development](#development)
- [Contributing](#contributing)

---

## Features

- **Real OAuth login** — authenticates through xAI's official OAuth endpoint (same flow as the Grok CLI)
- **Browser or device login** — browser authorization-code + PKCE stays the desktop default, with native device authorization for SSH, WSL, containers, and remote/headless sessions
- **Automatic browser open** — browser login opens your default browser automatically and retains the matching-state full-redirect paste fallback
- **Token refresh** — refresh tokens are stored and rotated automatically before expiry
- **Reuses existing credentials** — auto-detects `~/.grok/auth.json` from the official Grok CLI
- **Grok 4.5 flagship (default)** — xAI's newest model for coding, agentic tasks, and knowledge work; 500K context, text+image input, high reasoning by default
- **Grok 4.5 fast mode** — same model with `low` reasoning effort (`/think low` or `grok-4.5:low`); not a separate model ID
- **Grok 4.3 OAuth compatibility** — advertises the independently verified `grok-4.3` request route only when `grok-4.5` is entitled, retaining authenticated input evidence and conservative limits
- **Authenticated model catalog** — fetches the OAuth-visible `/models-v2` list from the official CLI proxy, so additions and removals track the signed-in account
- **Explicit subscription usage** — `/xai-usage` performs a bounded, identity-first lookup against the revision-pinned unofficial Grok billing surface without retaining account identity
- **Coding models when entitled** — directly advertised Grok Build variants track the account catalog; the Composer compatibility alias appears only while its verified `grok-4.5` entitlement source is present
- **Reasoning support** — parses supplied reasoning capability and thinking levels while preserving known model compatibility
- **Bounded last-known-good cache** — avoids routine startup delay and falls back safely when discovery is offline or unavailable
- **Custom xAI tools** — generate text, web search, X/Twitter search, multi-agent research, code analysis
- **Credential-aware Responses routing** — OAuth/session traffic uses the official `https://cli-chat-proxy.grok.com/v1` endpoint; built-in `xai` API-key tool traffic uses the public `api.x.ai` Responses endpoint
- **Revision-pinned wire contract** — route-specific headers, truthful package identity, protected request metadata, redirect rejection, and the upstream Grok Build review procedure are documented without impersonating the official client

> **✅ Verified (May 2026)**: All custom xAI tools (`xai_generate_text`, `xai_x_search`, `web_search`, `xai_code_execution`, `xai_critique`, `xai_multi_agent`, `xai_deep_research`, image tools, etc.) have been tested end-to-end after the OAuth + payload repair. The provider now correctly handles mixed-model requests and native xAI tool shapes.

---

## Package Scope

`pi-xai-oauth` owns the xAI-specific integration needed to use entitled Grok models through pi: authentication and credentials, account-specific catalogs, transport and payload behavior, Grok-native compatibility adapters, opt-in network tools, and media integrations. It intentionally does not provide generic `/goal` or `/plan` commands, autonomous continuation, a runtime plan-file protocol, generic task/subagent orchestration, or plan-mode write restriction. See [ADR 0001](docs/decisions/0001-goal-plan-package-scope.md) for the decision and alternatives.

Tool hiding, active-tool filtering, and shell-command filtering are workflow controls, not an enforced read-only boundary. Pi and its extensions run with the user's permissions; strong isolation requires an external sandbox, container, or VM that constrains every tool and extension involved.

The optional [`--scaffold`](#agent-scaffolding) command is separate: it performs one-time generation of `AGENTS.md` and `.scaffold/*` guidance files in the current directory. It is not a runtime workflow controller, an authoritative plan-state protocol, or a security mechanism.

---

## How It Works

`pi-xai-oauth` registers an OAuth provider called `xai-auth` in pi's provider registry. When you launch `pi` and run `/login xai-auth`, pi offers two native login methods:

- **Browser login (default):** starts a loopback callback listener, opens xAI authorization with PKCE S256, requires matching state for HTTP or pasted full-redirect callbacks, and verifies the fresh ID token against the pinned issuer/JWKS, ES256 policy, audience, expiry, and nonce.
- **Device code login:** requests a challenge from the pinned first-party device endpoint, shows the verification URL and user code through pi's device UI, and polls the pinned token endpoint only after the server interval. It handles pending/slow-down, denial, expiry, cancellation, malformed responses, and a bounded timeout without displaying the opaque device code or token responses.

Only a completed selected login returns access + refresh credentials for pi to persist. It then performs a bounded authenticated `GET https://cli-chat-proxy.grok.com/v1/models-v2`, filters unsafe/API-key-only entries, and immediately replaces the provider catalog. All OAuth-backed Responses traffic uses xAI's session-token proxy; proxy requests truthfully identify `pi-xai-oauth`, protect internally owned metadata from caller overrides, and include the required auth, client-mode, request, conversation, session, and model fields. Streaming requests explicitly negotiate server-sent events; direct Responses requests remain JSON.

Browser login still supports the **complete redirect URL** paste fallback when localhost is unreachable. The URL must contain the matching OAuth `state`; raw authorization codes are not accepted. Device login is the cleaner choice when the browser cannot reach the pi process.

---

## Installation

### One-command install (recommended)

```bash
npx pi-xai-oauth
```

This runs the setup script which:
1. Installs `npm:pi-xai-oauth` into pi
2. Seeds `defaultProvider: "xai"` only when no provider is configured (never overwrites an existing choice, including package-owned `xai-auth`)
3. Sets `grok-4.5` as your default model
4. Enables `high` thinking level by default

Chat stays on Pi's built-in `xai` provider by default. This package still registers optional `xai-auth` for its account catalog/stream path, and both providers can use `/xai-tools` plus `/xai-usage`.

### Manual install

```bash
pi install npm:pi-xai-oauth
```

Recommended settings for native SuperGrok chat plus this package's tools/usage:

```bash
# In ~/.pi/agent/settings.json:
{
  "defaultProvider": "xai",
  "defaultModel": "grok-4.5",
  "defaultThinkingLevel": "high"
}
```

Authenticate with `/login xai`. Use `/login xai-auth` only when you want this package's OAuth Responses catalog instead of Pi's built-in xAI chat.

> **⚠️ Important: install only one copy**
>
> `pi-xai-oauth` registers fixed private tool names such as `xai_generate_text`, `xai_grok_web_search`, and `xai_x_search`. If you install more than one copy — for example `npm:pi-xai-oauth` plus a local checkout, or two different local checkouts — pi will fail to start with `Tool "xai_generate_text" conflicts with ...` errors.
>
> Check with:
> ```bash
> pi list
> ```
>
> For local development, keep only this checkout:
> ```bash
> pi remove npm:pi-xai-oauth
> pi remove /path/to/other/pi-xai-oauth-copy
> pi install .
> ```
>
> For the published npm package, remove local checkouts:
> ```bash
> pi remove /path/to/local/pi-xai-oauth-copy
> pi install npm:pi-xai-oauth
> ```
>
> Use the exact package spec/path shown by `pi list` when removing duplicates.

---

## Pi Compatibility

Both Pi runtime peers use the same bounded range:

```text
@earendil-works/pi-ai:            >=0.80.1 <0.83.0
@earendil-works/pi-coding-agent:  >=0.80.1 <0.83.0
```

The lower boundary is **0.80.1**, the first published Pi 0.80 release. It provides the `@earendil-works/pi-ai/compat` transport used by this extension and the matching Pi 0.80 extension-loader contract. The packed package's complete test and typecheck suites run against exact 0.80.1 in CI. The other matrix boundary is exact **0.82.1**, the latest release inside the allowed line when this policy was reviewed. Pi 0.80.8 introduced the unified `ModelRuntime` credential API and replaced the exported `AuthStorage` surface with `readStoredCredential()` for one-off reads; this package supports both the 0.80.1 legacy surface and the 0.81.x/0.82.x ModelRegistry projection of `ModelRuntime.getAuth` through a bounded compatibility path. Pi 0.82 additionally reads the tool execution context's session manager, active model, and thinking level to expose `PI_*` session metadata to `bash`; the Grok-native `run_terminal_command` adapter delegates that context unchanged and is covered by the packed 0.82 boundary run.

The exclusive `<0.83.0` upper bound is deliberate. Pi is pre-1.0, so a new minor line may contain breaking API or loader changes; this project does not claim support until that line passes the packed compatibility suite. npm therefore reports a peer-resolution warning or error during installation for older releases such as 0.79.10 and for the untested 0.83 line, rather than allowing a later runtime loader failure.

Older `pi-xai-oauth` 1.2.4 builds supported Pi 0.79.8's then-current Responses guard. Current code uses the Pi 0.80 compat dispatcher after the 1.3.2 export migration and 1.3.3 loader-resolution fix, so that historical statement is not the current minimum.

The xAI transport contract is tracked separately from Pi package compatibility. See [Grok Build wire-protocol compatibility](compatibility/grok-build-wire-protocol.md) for the pinned upstream revision, route/header matrix, identity and ID-ownership policy, encrypted-reasoning replay contract, safe errors, and repeatable review procedure.

### Encrypted reasoning replay

On the pinned OAuth Responses route, requests default an absent `store` to `false` and request `reasoning.encrypted_content`. Pi retains completed reasoning output items as opaque state and replays them inline only when the provider, API, and exact model still match. Switching targets drops that replay; compaction may intentionally replace older active context.

`store: false` disables server-side response storage, but it does **not** mean no local sensitive state. Complete encrypted reasoning items are stored in ordinary Pi session JSONL under Pi's normal permissions and retention. This package does not separately encrypt that file, copy reasoning into another cache, or protect it from the user or trusted local extensions.

If xAI reports that encrypted reasoning is incompatible with the selected model, the request is not retried automatically. Start a clean session or turn and keep the same xAI model for subsequent replay.

---

## Authentication

```bash
pi
```

Then, in the pi TUI:

```text
/login xai-auth
```

**What happens:**

1. pi checks for existing Grok CLI credentials (`~/.grok/auth.json`). If found, it asks if you want to reuse them without modifying that file.
2. If a fresh login is needed, choose **Browser login (default)** or **Device code login**.
3. Browser login opens xAI in your default browser and completes through the state-bound loopback/full-redirect flow.
4. Device login displays a clickable verification URL and user code. Open it on any browser-capable device, confirm the code, and leave pi open while it waits. Press Escape to cancel safely.
5. Only successful access + refresh credentials are stored by pi and refreshed automatically.

Fresh logins request xAI's current eight-scope Grok client grant, including `conversations:read` and `conversations:write`. Credentials created before those scopes were added remain refreshable: refresh preserves the existing grant and does not renegotiate scopes.

> **Need the new conversation scopes?** Run `/login xai-auth` for a fresh authorization grant. If pi finds `~/.grok/auth.json` and asks whether to reuse it, answer **`n`** so the browser login runs; reusing or refreshing an older credential will not add scopes. You do not need to re-login merely to keep using an older credential that already works for your requests.
>
> **Choosing a different browser/profile?** The instructions in the TUI explain how. You can copy the shown authorization URL and open it manually in your preferred browser.
>
> **Which method should I choose?** Use **Browser login** on a normal desktop where the browser can reach pi's loopback listener. Use **Device code login** for SSH, WSL, Docker/dev containers, remote VMs/workspaces, or other human-operated headless sessions. Device login is not intended for unattended automation because a person must approve the displayed code. If you stay with browser login remotely, paste the complete failed redirect URL—not a raw code—so pi can verify state.

### Re-authenticating

Tokens are refreshed automatically, but if you want to force a fresh login:

```bash
pi
```

Then, in the pi TUI:

```text
/login xai-auth
```

The existing `~/.grok/auth.json` prompt lets you either reuse or re-authenticate.

---

## Usage

Once authenticated, start using Grok:

```bash
pi "Explain quantum computing like I'm 5"
```

Or use a specific model:

```bash
pi --model grok-4.5 "Write a poem about Rust"
```

### Subscription usage (unofficial)

Run an explicit one-shot usage lookup from pi:

```text
/xai-usage
```

The command displays only validated fields that xAI actually returned, such as included usage percentage, legacy included-credit totals, current reset time, on-demand usage/cap, prepaid balance, and bounded history count. Missing optional fields stay omitted.

The billing surface is **not a stable public xAI API**. This implementation is pinned to [`xai-org/grok-build@b189869`](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-shell/src/extensions/billing.rs): it first makes authenticated `GET /v1/user`, uses the returned validated `userId` only for the immediately following `GET /v1/billing?format=credits`, then discards it. The command accepts a current Pi-stored OAuth credential under this package's `xai-auth` provider or Pi's built-in `xai` SuperGrok/X Premium provider, and rejects stored, environment, or runtime API-key provenance. Account identity, bearer/authenticated headers, and raw response bodies are never logged, displayed, cached, or persisted. If identity cannot be resolved safely, billing is not requested.

The compact footer status is off by default and requires a separate per-session opt-in while an `xai-auth` or built-in `xai` model is active with Pi-managed OAuth:

```text
/xai-usage status
/xai-usage status on
/xai-usage status off
```

Enabling status performs one immediate lookup. Later refreshes are event-driven after completed turns and occur no more than once per minute. The status disables and clears on model, provider, login, or session changes and on the next extension-handled event after stored OAuth removal; it never refreshes for non-xAI models. Status failures clear silently and never interfere with chat. Every request rejects redirects, has a 15-second timeout, reads at most 64 KiB, and applies bounded JSON depth, collection counts, history length, and numeric ranges.

### Switching Models

`/model` shows the current authenticated account's xAI catalog plus narrowly scoped compatibility routes whose entitlement source is present. A successful refresh remains authoritative: newly returned entitlement sources appear, removed sources and their compatibility routes disappear, hidden entries are omitted, and known API-key-only models such as `grok-build-0.1` are never advertised through `xai-auth`.

Common catalog entries include:

| Model ID | Description |
|----------|-------------|
| `grok-4.5` | **Default and curated offline fallback.** xAI flagship; reasoning low (**fast**) / medium / high (default), 500K context, text+image. |
| `grok-4.3` | OAuth-compatible request model when `grok-4.5` is entitled; keeps authenticated input evidence and conservative catalog-derived limits. |
| `grok-build` | When entitled: Grok Build coding model (same Grok-native tools as other xai-auth models). |
| `grok-composer-2.5-fast` | Compatibility alias of entitled `grok-4.5`; uses the same Grok-native pi tool adapters and no Cursor-named shims. |
| `grok-4.20-0309-reasoning` | When entitled: Grok 4.20 with automatic reasoning. |
| `grok-4.20-0309-non-reasoning` | When entitled: Grok 4.20 non-reasoning variant. |
| `grok-4.20-multi-agent-0309` | When entitled: Grok 4.20 multi-agent research model. |

The exact list is account-specific and can change independently of package releases. From the pi TUI:

```
/model grok-4.5
/model grok-4.3
/model grok-build
/model grok-composer-2.5-fast
/model grok-4.20-0309-reasoning
/model grok-4.20-multi-agent-0309
```

From the command line:

```bash
pi --model grok-4.5 "Your prompt here"
pi --model grok-4.3 "Use Grok 4.3"
pi --model grok-build "Implement this feature"
pi --model grok-composer-2.5-fast "Refactor this module"
pi --model grok-4.20-0309-non-reasoning "Quick answer"
```

### Authenticated input capabilities

When `/models-v2` supplies a valid `acceptsImages` boolean or bounded `inputModalities` array, that authenticated evidence overrides the package's known metadata for the returned model. `acceptsImages` takes precedence over `inputModalities`; entry fields take precedence over the matching `_meta` field. Missing or malformed evidence falls back to known metadata for known models and conservative text input for unknown models. Missing fields do **not** make Composer text-only.

The normalized cache stores only the final modalities and bounded provenance, never the raw catalog fields. Legacy schema-1 caches are migrated in memory without treating their inferred input as authenticated evidence. If an authenticated entitlement explicitly becomes text-only, image-bearing Responses payloads fail locally after payload hooks and before any network request, including `xai_generate_text(image_url)` and `xai_analyze_image`. Image generation is a separate endpoint and is unaffected.

See [Authenticated model input modalities](docs/model-input-modalities.md) for the redacted 2026-07-16 schema observation, pinned xAI source revision, exact precedence, malformed-field policy, and cache migration contract.

#### Opt-in vision routing for explicit text-only entitlements

If—and only if—the active model is an exact authenticated catalog member with validated text-only evidence, `/xai-tools enable vision-routing` can route current image input through a separate exact catalog model with validated text-and-image support. The vision model receives the images in one additional authenticated Responses request; the active model then receives a clearly labeled text description and no image data. Missing fields, curated metadata, aliases, compatibility slugs, and model names such as Composer never qualify either side.

```text
/xai-tools status
/xai-tools enable vision-routing
/xai-tools disable vision-routing
```

Eligible targets are ordered deterministically by normalized exact model ID. Routing is disabled by default, binds to the current source model, and resets on a new session, every model change, leaving xAI, login/account replacement, catalog replacement, or shutdown. Disabled or invalid routing retains the existing local text-only rejection and creates no additional request.

Each routed turn may consume additional allowance, credits, and rate limits. Images are disclosed to the selected vision target, and its generated description becomes potentially sensitive session content supplied to the active model. The package creates no cross-request raw-image or description cache. Cancellation and catalog invalidation stop the remaining route; a failed description never falls back to sending or silently stripping the source image.

### Catalog refresh and cache policy

The normalized, token-free last-known-good catalog is stored at:

```text
~/.pi/agent/cache/pi-xai-oauth/models-v2.json
```

- **Fresh for 15 minutes:** with a usable OAuth credential (or an expired stored credential awaiting pi's lock-protected refresh), startup and `/reload` use the cache immediately and do not make a catalog request. Logged-out startup uses the curated fallback instead of exposing the previous account's cache.
- **Stale refresh:** after 15 minutes, startup performs one authenticated GET bounded to 5 seconds.
- **Transient fallback:** network errors, timeouts, HTTP 408/429/5xx, or a malformed successful response may reuse a validated cache no older than 7 days. A forced/deferred refresh never reuses stale account data; it uses the curated fallback and remains retryable with a one-minute in-session backoff.
- **Auth/permanent failure:** HTTP 401/403 or other permanent 4xx responses invalidate cached entitlements and use the curated `grok-4.5` fallback.
- **Login:** every successful browser, device, or reused-credential `/login xai-auth` forces a refresh with the returned credential, never reuses stale data, and updates `/model` immediately. A failed/cancelled selected login leaves existing credentials and catalog state intact. If catalog refresh alone fails after authentication, login still succeeds and the curated fallback is used.
- **`/reload`:** recreates the extension and follows the same 15-minute policy; it is not an unconditional network refresh.
- **Selection:** if a refresh removes the active xAI model, the next turn switches to an entitled xAI replacement when available; otherwise it aborts before sending an unentitled request.

The cache stores only normalized model definitions, bounded input-capability provenance, and timestamps. It never stores access/refresh/ID tokens, auth headers, raw endpoint responses, endpoint fields, or account identity fields. Startup does not expose a previous account's fresh cache when no credential exists, and a credential-file modification newer than the cache forces discovery. If an exceptional filesystem error prevents replacing or deleting an old cache, a token-free `.invalidated` sidecar suppresses it until a later successful atomic write. A token-free cache still cannot distinguish an external account replacement that deliberately preserves the credential file's timestamp; in-product login always bypasses and replaces the cache.

### Reasoning / Thinking Levels

Grok 4.5 and the entitlement-gated Grok 4.3 compatibility route expose configurable thinking levels via pi's `/think` command or `model:effort` syntax. There is **no separate `grok-4.5-fast` model** — on Grok 4.5, “fast mode” is **`reasoning_effort: "low"`** on the same model ID.

```
/think high
/think medium
/think low      # Grok 4.5 fast mode
```

Or via CLI:

```bash
pi --model grok-4.5:high "Solve a complex math problem"
pi --model grok-4.5:medium "Summarize this design doc"
pi --model grok-4.5:low "What's the weather?"   # fast / latency-sensitive
```

| Effort | Grok 4.5 behavior (per xAI docs) | Best for |
|--------|-----------------------------------|----------|
| **`high`** (default) | More reasoning tokens, deeper thinking | Hard coding, complex math, multi-step logic |
| **`medium`** | Balanced thinking vs latency | Analysis and longer-context work |
| **`low`** (**fast mode**) | Some reasoning, still fast | Latency-sensitive agents and simple tool calling |

`grok-4.5` defaults to **high** when no effort is specified; reasoning **cannot be disabled** (`/think off` is not supported for this model). Every model selected through the OAuth-only `xai-auth` runtime catalog sends Responses traffic through xAI's Grok CLI session endpoint using the same X account OAuth token. An entitled `grok-build` entry still receives its legacy Responses payload/header compatibility behavior, while every `xai-auth` model uses the same Grok-native local tool adapters. The Composer alias (`grok-composer-2.5-fast`) follows the Grok 4.5 payload path. `grok-4.20-0309-reasoning` reasons automatically and does not accept a configurable effort parameter. `grok-4.20-multi-agent-0309` uses `medium` for 4 agents and `high` for 16 agents.

#### Switching between `xai` and `xai-auth`

Setup seeds Pi's built-in `xai` provider when no provider is configured, so the same Grok model can be reached through two separate catalogs. They are deliberately **not** merged: built-in `xai` is Pi's generated API-key catalog, while `xai-auth` derives levels from your authenticated `/models-v2` entitlements plus bounded known metadata. Levels can therefore differ:

| Model | Built-in `xai` | `xai-auth` | Why |
|-------|----------------|------------|-----|
| `grok-4.5` | `low` / `medium` / `high` | `minimal` / `low` / `medium` / `high` | **Intentional.** `xai-auth` maps Pi's `minimal` onto xAI's `low`, so `/think minimal` and `/think low` send the same `reasoning_effort: "low"` request. Selecting `minimal` never sends an effort xAI did not advertise. |
| `grok-4.3` | `off` / `minimal` / `low` / `medium` / `high` | same | Identical on both paths. |
| `grok-build-0.1` | available | **never advertised** | API-key-only model; it is excluded from `xai-auth` regardless of what a catalog response contains. |

Authenticated evidence always wins on the `xai-auth` path. If `/models-v2` reports `supports_reasoning_effort: false`, the model drops to `off` only even when known metadata lists `low`/`medium`/`high`. Levels absent from `reasoning_efforts` stay hidden, and Pi clamps a request for a hidden level down to the nearest advertised one. `xhigh` appears only when the catalog names xAI's `max` effort; Pi's own `max` level is never advertised for Grok.

### Grok 4.5 source notes

Official xAI sources used for this catalog update:

- [Grok 4.5 guide](https://docs.x.ai/developers/grok-4-5) — model ID, API usage, reasoning levels, tools, and availability notes.
- [Grok 4.5 model details](https://docs.x.ai/developers/models/grok-4.5) — text+image input, 500K context window, cached input pricing, regions, and rate-limit snapshot.
- [Reasoning docs](https://docs.x.ai/developers/model-capabilities/text/reasoning) — `low` / `medium` / `high` reasoning effort, default `high`, and non-disableable reasoning.
- [Launch announcement](https://x.ai/news/grok-4-5) — coding/agentic benchmark notes, Grok Build/Cursor availability, and EU availability caveat.

No Grok 4.5-specific model card, label card, system card, paper, or official max-output-token limit was found in the xAI docs/news/data sources during this update. The package keeps the existing Grok Responses max-token ceiling as a placeholder until xAI publishes official model metadata for that field.

### Grok-native tools

For every active `xai-auth` model, this package advertises Grok-native client names—using the same name-override idea as Grok's `ToolConfig::with_name()`—and maps them onto pi capabilities:

| Grok-native tool | pi capability used underneath |
|------------------|-------------------------------|
| `read_file` | `read` |
| `search_replace` | strict exact-string replacement; `write` when `old_string` is empty |
| `list_dir` | `ls` |
| `grep` | bounded local content search |
| `run_terminal_command` | `bash` |
| `web_search` | xAI native web search (opt-in via `/xai-tools`) |

The model-facing fields follow Grok's contract: `target_file` plus signed `offset`, unsigned `limit`, `pages`, and `format` for `read_file`; `file_path`, `old_string`, `new_string`, and optional `replace_all` for `search_replace`; `target_directory` for `list_dir`; Grok's path/glob/context fields for `grep`; and millisecond `timeout` plus `description`/`background` for `run_terminal_command`. Pi has no managed background-task lifecycle, so `background: true` is rejected explicitly rather than being silently run in the foreground. PDF page rendering is not available through pi's text reader, so PDF `read_file` calls fail with an explicit guidance error. The local `grep` adapter preserves Grok's bounded output and timeout behavior while using a conservative workspace-only matcher and file-type subset. `web_search` preserves the optional `allowed_domains` list exactly.

The direct `read_file`, `search_replace`, `list_dir`, and `grep` adapters accept relative paths and absolute paths whose resolved target stays inside the active workspace. Escaping `..` traversal, outside absolute paths, and symlinks that resolve outside are rejected. `search_replace` may create a missing leaf only when its resolved physical parent remains inside the workspace. Package-owned full-file reads used for negative-offset `read_file` and exact `search_replace` are capped at 5,000,000 bytes.

`run_terminal_command` is deliberately outside that direct-adapter containment policy: it delegates the command to pi's `bash` tool and may access paths outside the workspace. These checks are defense-in-depth for the direct file adapters, not a complete filesystem sandbox for the coding agent.

Legacy Cursor names (`Read`, `Shell`, `WebSearch`, and similar) are no longer registered by this package. Local Grok-native adapters enable automatically only for `xai-auth` and clear when you leave that provider without mutating same-named public tools owned by other extensions. Internally they use collision-free `xai_grok_*` dispatcher names, then expose the official public names only in the current package-owned xAI request, so unrelated extensions can keep their own public tools. The network-backed `web_search` remains opt-in and also supports Pi's built-in `xai` models.

---

## Custom Tools

This package registers credential-backed custom tools that make additional xAI API requests. They appear alongside your other agent tools in the pi TUI, but all of them are **inactive by default**. For Pi's built-in `xai` provider, SuperGrok/X Premium OAuth uses the subscription session route while API-key provenance uses the public `api.x.ai` route.

This opt-in boundary applies only to the extra tools below. Normal conversation continues through the selected provider: this package owns `xai-auth` chat/catalog/stream behavior and does not replace or intercept Pi's built-in `xai` transport.

| Tool | Category | Additional usage / cost risk |
|------|----------|------------------------------|
| `xai_generate_text` | Generation | Separate model-token usage |
| `xai_x_search` | Search | Model tokens plus native tool usage |
| `xai_multi_agent` | Research | High/variable: 4 or 16 agents plus web/X tools |
| `xai_deep_research` | Research | High/variable model and web/X tool usage |
| `xai_code_execution` | Execution | Model tokens plus code-interpreter usage |
| `xai_generate_image` | Image generation | Charged per generated image; supports 1-4 images |
| `xai_edit_image` | Image editing | Imagine usage for one output conditioned on 1-3 local references |
| `xai_image_to_video` | Video generation | High-cost, long-running 6- or 10-second video generation |
| `xai_analyze_image` | Vision | Separate model-token and image-input usage |
| `xai_critique` | Reasoning | Separate high-reasoning model-token usage |
| `web_search` | Search | Model tokens plus native tool usage |

**How to use them:** Select an `xai-auth` model or Pi built-in `xai` model, enable only the tool you want through `/xai-tools`, then explicitly request that tool in your prompt or agent workflow. Credential lookup stays on the active xAI-compatible provider (`xai-auth` OAuth, or built-in `xai` OAuth/API keys) and the existing Grok CLI credential fallback; it does not silently borrow a sibling provider's stored credentials. Enabling a tool makes it available; it is not permission for the model to call it without user intent.

Every new session resets all network-backed tools to inactive. Switching to a non-xAI model disables them immediately, and switching back does not restore them. Grok-native local filesystem and shell tools remain automatic only for `xai-auth`; built-in `xai` models receive no package-owned local adapters.

In the pi TUI, select an `xai-auth` or built-in `xai` model and run:

```text
/xai-tools
```

The picker shows each tool's category and cost-risk context, warns that calls may use xAI credits, and applies changes only to the current xAI session. Use ↑/↓ to move, Enter or Space to toggle a tool in place, and Escape when done; the highlighted row stays put after each toggle. You can also manage one tool directly:

```text
/xai-tools status
/xai-tools enable web_search
/xai-tools disable web_search
/xai-tools enable xai_generate_image
/xai-tools enable xai_edit_image
/xai-tools enable xai_image_to_video
/xai-tools enable vision-routing
/xai-tools disable vision-routing
```

`vision-routing` is transport policy rather than a callable model tool, so it never enters Pi's active-tool registry. It appears only when exact authenticated capability evidence supports a text-only source and a separate text-and-image target. `web_search` appears once in the picker for any active xAI model (still opt-in); the older `xai_web_search` spelling remains accepted only as a backward-compatible `/xai-tools enable` or `disable` argument. `/xai-tools` is owned by this package; it does not depend on pi's optional example `/tools` extension.

Extension authors that drive `/xai-tools` through `pi.events` must follow the listener-owned [xAI tools menu bridge protocol v1](docs/bridge-xai-tools.md), including its early `open` launch acknowledgement and honest success/error results.

> **Tip:** See the ⚠️ warning above about local vs published package conflicts.

### `xai_generate_text`
Opt-in text generation with full reasoning and stateful conversations. Enable it through `/xai-tools` first.

```json
{
  "prompt": "Explain neural networks",
  "model": "grok-4.5",
  "reasoning_effort": "high"
}
```

### `xai_multi_agent`
Opt-in deep multi-agent research using Grok's multi-agent model plus native web and X search tools. Enable it through `/xai-tools` first.

```json
{
  "query": "Latest advances in LLM quantization",
  "num_agents": 16,
  "reasoning_effort": "high"
}
```

### `web_search`
Opt-in search using xAI's native `web_search` tool and the active xAI model. Enable it through `/xai-tools` first. The optional `allowed_domains` list is forwarded unchanged.

```json
{
  "query": "Rust vs Go performance 2026",
  "allowed_domains": ["rust-lang.org", "go.dev"]
}
```

### `xai_x_search`
Opt-in X (Twitter) search using xAI's native `x_search` tool and the active xAI model. Enable it through `/xai-tools` first.

```json
{
  "query": "grok 4.5"
}
```

### `xai_code_execution`
Opt-in Python-oriented analysis using xAI's native `code_interpreter` tool. Enable it through `/xai-tools` first.

```json
{
  "code": "print(sum(range(100)))"
}
```

### `xai_generate_image`
Opt-in paid image generation with xAI's current image generation model. Enable it through `/xai-tools` first, and request it explicitly in your prompt.

```json
{
  "prompt": "A clean product diagram of an OAuth flow",
  "model": "grok-imagine-image-quality"
}
```

### `xai_analyze_image`
Opt-in analysis of an image URL, data URL, or bounded local `.png` / `.jpg` path with Grok vision. Local files must be inside the active workspace. Enable it through `/xai-tools` first.

```json
{
  "image": "assets/screenshot.png",
  "question": "What error is visible?"
}
```

Legacy local image inputs are limited to byte-validated PNG/JPEG regular files inside the
active workspace. Paths are resolved through realpath, so traversal and outward symlinks are
rejected; reads are capped at 8 MiB and 12 million decoded pixels before base64 encoding.
Absolute paths and `file://` URLs remain compatible only when their resolved file is inside
that workspace.

### `xai_edit_image`

Opt-in paid image editing through xAI Imagine. Enable it through `/xai-tools` first, then explicitly request the edit. Supply one to three references. One reference preserves its input aspect ratio; a supported `aspect_ratio` may be supplied but is omitted from the wire. Multiple references require a supported `aspect_ratio`.

```json
{
  "prompt": "Keep the subject, replace the background with a clean studio gradient",
  "image": [{ "path": "assets/reference.png" }]
}
```

References are limited to 1-3 byte-validated PNG/JPEG files inside the current workspace or strict bounded `data:image/png;base64,...` / `data:image/jpeg;base64,...` values. Paths are resolved through realpath, so `..` escapes and symlinks leaving the workspace are rejected. HTTPS URLs, `file://` URLs, current-turn attachment tokens, arbitrary outside paths, SVG, WebP, GIF, and HEIC are intentionally unsupported.

Reference handling uses the pinned Grok Build policy as its starting point: sources are capped at 8 MiB and 12 million decoded pixels; compatible references up to 400 KiB pass through after decode verification; larger references are re-encoded under 400 KiB with a 768 px maximum side, a 256 px compression floor, and reviewed quality steps. The package separately limits aggregate reference bytes to 1,200 KiB and caps reference count, request JSON, response JSON, output base64, decoded output bytes, output pixels, and output dimensions.

Exactly one verified PNG/JPEG output is saved atomically with a collision-resistant name under Pi's session directory at `pi-xai-oauth/<session-hash>/image-edits/`. Directories use mode `0700`, files use `0600`, and the tool returns path/dimension/size metadata instead of raw base64. Prompts, source paths, data URLs, image bytes, credentials, headers, and raw authenticated error bodies are never included in image-edit errors.

Image editing can consume xAI Imagine allowances, credits, or rate limits. Exact pricing and quota behavior are controlled by xAI; see [xAI pricing](https://docs.x.ai/developers/pricing) before enabling the tool.

### `xai_image_to_video`

Opt-in high-cost image-to-video generation through `grok-imagine-video-1.5-preview`. Enable it explicitly, then provide exactly one bounded workspace PNG/JPEG or strict PNG/JPEG data URL. Remote source URLs and multi-reference video generation are intentionally unsupported.

```json
{
  "image": { "path": "assets/reference.png" },
  "prompt": "Slow camera push-in with subtle ambient motion",
  "duration": 6,
  "resolution": "480p"
}
```

Duration is `6` or `10` seconds (default `6`); resolution is `480p` or `720p` (default `480p`). The client waits five seconds before its first status request, polls every five seconds, and stops local tracking after five minutes. Video generation can be expensive and rate-limited. Cancelling Pi stops local waiting, requests, download, and partial-file writes, but the submitted remote xAI job is **not cancelled** and may continue consuming usage or credits.

Completed MP4s are downloaded without OAuth headers through an HTTPS-only, no-redirect, resolve-once public-IPv4 DNS/IP-pinned transport; IPv6-only download hosts fail closed. Downloads accept only MP4 MIME, are streamed under a 256 MiB limit, require bounded `ftyp` evidence, and are atomically saved under `pi-xai-oauth/<session-hash>/videos/` with private `0700` directories and `0600` files. Signed URLs, request IDs, source data, prompts, credentials, and raw authenticated bodies are not returned or logged.

### `xai_critique`
Opt-in structured critique for code, designs, writing, or ideas. Enable it through `/xai-tools` first.

```json
{
  "content": "function add(a,b){ return a-b }",
  "aspect": "code correctness"
}
```

### `xai_deep_research`
Opt-in research using the active xAI model plus native web and X search tools. Enable it through `/xai-tools` first.

```json
{
  "topic": "Recent xAI Responses API tool changes",
  "depth": "high"
}
```

> **Note:** Every tool in this section makes a separate xAI request and can consume subscription allowances, credits, or rate limits. OAuth-backed Responses helpers use the session proxy; built-in `xai` API-key helpers use the public API. Image generation and image editing are intentional OAuth transport exceptions: matching official Grok Build behavior, they send the OAuth bearer directly to the pinned public Images routes at `https://api.x.ai/v1/images/generations` and `https://api.x.ai/v1/images/edits`. See [xAI pricing](https://docs.x.ai/developers/pricing) for current rates.

---

## Quick Reference

| Action | Command |
|--------|---------|
| Install | `pi install npm:pi-xai-oauth` |
| One-command setup | `npx pi-xai-oauth` |
| Try ephemeral | `pi -e npm:pi-xai-oauth` |
| Authenticate (chat default) | Launch `pi`, run `/login xai` |
| Authenticate (optional package catalog) | Launch `pi`, run `/login xai-auth`, then choose browser (default) or device code |
| Update | `pi update npm:pi-xai-oauth` |
| Remove | `pi remove npm:pi-xai-oauth` |
| List packages | `pi list` |
| Set default model | `/model grok-4.5` (in TUI) |
| Set thinking level | `/think high` (in TUI) |
| Show subscription usage | `/xai-usage` (unofficial, explicit request) |
| Manage optional usage status | `/xai-usage status on\|off` (off by default) |
| Manage outbound xAI tools | `/xai-tools` (in TUI) |
| Recreate extension/catalog state | `/reload` (respects the 15-minute cache TTL) |

---

## Troubleshooting

### "Browser didn't open automatically"

pi runs `open <url>` on macOS / `xdg-open` on Linux to launch your default browser. If nothing happens:

- **Copy the URL** shown in the TUI and paste it into your preferred browser manually.
- The local callback server is still listening — once you authorize, the redirect will be caught even if the browser doesn't match.

### "Callback server didn't receive the redirect"

If localhost is blocked (VPN, Docker, remote SSH, WSL):

1. After authorizing in the browser, the page will show an error (can't reach localhost).
2. **Copy the complete URL** from the browser's address bar. It must include both `code` and the matching `state` query parameter.
3. **Paste it into the TUI's input field** that says "Paste redirect URL below."
4. pi verifies the state, exchanges the bound code with PKCE, validates the returned OIDC ID token, and then completes login.

Raw authorization-code-only input is intentionally rejected because it cannot prove which browser login attempt produced the code. If you already pasted a raw code, run `/login xai-auth` again and either choose **Device code login** or choose browser login and paste the complete redirect URL.

### "Device authorization expired or was denied"

Run `/login xai-auth` again and choose device login to request a new code. Codes are short-lived and polling stops at the server expiry (with a 15-minute hard cap). Pressing Escape cancels the wait; denial, expiry, cancellation, network failure, or malformed server data returns no new credential and does not remove the previous one.

### "Cannot find provider xai-auth"

Run `pi list` to verify the package is installed. If not:

```bash
pi install npm:pi-xai-oauth
```

Then run `pi /list-providers` — you should see `xai-auth` listed.

### `422 "Failed to deserialize ... ModelInput"` with images

This means xAI rejected a multimodal Responses `input` shape. Use the latest package version and restart pi or run `/reload`. The provider normalizes validated, bounded workspace-local `.png`/`.jpg` paths into `data:image/...;base64,...` URLs, adds image `detail`, moves system/developer text to top-level `instructions`, and rewrites image-bearing tool results so `function_call_output.output` stays text-only (xAI rejects arrays there).

> **Fixed in repair**: Requests from other providers (DeepSeek, OpenAI Codex, etc.) no longer get mutated by the xAI sanitation hook.

If you call `xai_generate_text` directly, `image_url` may be either:

- an `http(s)://...` URL
- a `data:image/png;base64,...` or `data:image/jpeg;base64,...` URL
- a workspace-contained `.png`, `.jpg`, or `.jpeg` path, including shell-escaped paths like `assets/My\\ Image.png` and in-workspace absolute or `file://` paths

### `500 "Auth context expired"` after screenshots

This xAI OAuth gateway error can be a misleading response to an oversized stateless Responses request, not an expired local token. The provider now omits consumed historical tool-result image binaries after a later assistant response and retains a text marker in their place. Current PNG/JPEG inputs are resized with high-fidelity encoding when necessary and kept within a 3 MiB aggregate base64 transport budget before any xAI request is sent.

If an image cannot be decoded or compacted safely, the request fails locally with a clear image-budget error. Crop the screenshot or attach fewer current images; logging in again will not fix a payload-size failure.

### "Token expired / auth failed"

Tokens refresh automatically, but if something goes wrong:

```bash
pi
```

Then, in the pi TUI:

```text
/login xai-auth
```

This re-runs the full OAuth flow and replaces your stored tokens.

### "Does this need an xAI API key?"

**Not for the package-owned `xai-auth` provider.** It uses OAuth—the same authentication family as the official Grok CLI and chat interface—and does not expose an API-key chat provider. Responses requests for `xai-auth` use the OAuth session proxy.

The opt-in network tools can also run while Pi's built-in `xai` provider is active. Built-in SuperGrok/X Premium OAuth is tagged as a subscription session; a built-in xAI API key is tagged as `api-key` and sent only to the public `api.x.ai` route. `/xai-usage` remains OAuth-only and rejects API-key provenance.

If you have the official Grok CLI installed and authenticated (`~/.grok/auth.json`), this package detects and reuses those credentials automatically.

### "Why is a model missing or still cached?"

The xAI model list is entitlement-aware. If a model is missing, the authenticated `/models-v2` response did not include a usable OAuth Responses entry or a required entitlement source, or discovery fell back to the curated offline catalog. Run `/login xai-auth` to force an account-bound refresh. `/reload` reloads the extension but intentionally reuses a cache younger than 15 minutes; after the TTL it performs a bounded refresh. Known renames such as `grok-composer-2.5-fast` and `grok-build-latest` are advertised only as aliases of an already-entitled canonical model. The distinct `grok-4.3` request route is likewise advertised only when its independently verified OAuth entitlement source (`grok-4.5`) is present; none of these compatibility entries are persisted into the exact catalog cache.

A one-shot `pi --list-models` cannot refresh an already-expired pi-stored OAuth token before the model registry is bound. It can still use a fresh official Grok CLI bearer when available; otherwise it uses fresh cache or the curated fallback. Starting a normal session lets pi refresh its stored credential under the credential-store lock and then revalidate the catalog.

Do not add custom `xai-auth` entries to `~/.pi/agent/models.json`; that provider ID is owned by this extension. Pi can re-merge user-defined entries when an authenticated catalog is empty. The extension's input and transport guards still refuse any model absent from the active OAuth entitlement snapshot before an xAI request is sent, but such custom entries may remain visible in `/model` because pi exposes no extension API for removing disk-defined models from an otherwise empty provider.

### "What model am I using?"

In the pi TUI, the current model is shown in the status bar. You can also check with:

```
/model
```

### `Tool "xai_generate_text" conflicts with ...` or `pi list` shows duplicate copies

You have more than one copy of this extension installed. This commonly happens when updating from npm to a local checkout, or when switching between two local worktrees. pi refuses to load duplicate tool names.

First inspect installed packages:

```bash
pi list
```

Then remove every duplicate `pi-xai-oauth` entry except the one you want to use.

For local development from this checkout:

```bash
pi remove npm:pi-xai-oauth
pi remove /path/to/old/pi-xai-oauth-copy
pi install .
```

For normal npm usage:

```bash
pi remove /path/to/local/pi-xai-oauth-copy
pi install npm:pi-xai-oauth
```

Restart pi after cleanup. `pi list` should show only one `pi-xai-oauth` entry.

---

## Updating

```bash
pi update npm:pi-xai-oauth
```

This pulls the latest version from npm and updates your installed extension.

The current build requires aligned Pi runtime packages in `>=0.80.1 <0.83.0`, with exact packed-package validation at 0.80.1 and 0.82.1. Version 1.4.0 added opt-in vision routing, image-to-video generation, the menu bridge, built-in SuperGrok tool/usage support, and further transport and entitlement hardening on top of authenticated model discovery, device OAuth, encrypted reasoning replay, Grok-native tools, bounded image editing, and explicit subscription usage. See [CHANGELOG.md](CHANGELOG.md) for the complete release notes. If you installed the published npm package, update with the command above. If you are testing a local checkout instead, reinstall the checkout:

```bash
pi remove npm:pi-xai-oauth && pi install .
```

If you previously installed a local checkout with `pi install .`, `pi update npm:pi-xai-oauth` will not replace that local copy. Run `pi list` and make sure only one `pi-xai-oauth` entry is installed. Remove duplicate npm/local/worktree copies before restarting pi.

---

## Uninstalling

```bash
pi remove npm:pi-xai-oauth
```

This removes the extension from pi's package list. Your stored OAuth tokens remain in pi's credential store.

---

## Agent Scaffolding

This package ships with a modern scaffolding system designed for AI coding agents (2026 best practices).

### Bootstrap Scaffolding

```bash
npx pi-xai-oauth --scaffold
# or
npm run scaffold
```

Generates a full agent harness:
- `AGENTS.md` — Dedicated operations manual for AI agents
- `.scaffold/` with persistent state:
  - `plan.md` — Phased implementation roadmap
  - `constraints.md` — Hard rules and safety gates
  - `progress.md` — Live execution tracking
  - `context.md` — Shared context for multi-agent workflows

### Benefits
- Dramatically reduces exploratory turns and token waste
- Enables reliable long-running agentic tasks
- External state files allow agents to resume across sessions
- Built-in support for PARALLEL subagent delegation

Use this in any new project to get the same professional harness.

---

## Development

```bash
# Clone
git clone https://github.com/BlockedPath/pi-xai-oauth.git
cd pi-xai-oauth

# Install deps
npm install

# Full deterministic gate: policy, focused Vitest suites, and real Pi loader smoke
npm test

# Focused development commands
npm run test:unit -- tests/oauth/browser-login.test.ts
npm run test:unit -- -t "rejects raw codes"
npm run test:watch

# V8 coverage (text, JSON summary, and LCOV)
npm run test:coverage

# Run only the real Pi extension-loader integration smoke
npm run test:loader

# Type-check production, tests, fixtures, and Vitest config with TypeScript 7
npm run typecheck

# Strict asynchronous error validation
NODE_OPTIONS=--unhandled-rejections=strict npm test

# Verify source/lock/range/registry/packed metadata and unsupported peers
npm run compatibility:check

# Repack, install, report, test, and typecheck both exact Pi boundaries
npm run compatibility:boundaries

# Install local version in pi
pi install .

# Always work on a feature branch (per AGENTS.md)
git checkout -b feature/your-task
```

### Subscription-only OAuth routing smoke test

Use an account with an active SuperGrok/subscription entitlement but **no API-team credits or spending limit configured**. Install this checkout once, authenticate through `xai-auth` in the pi TUI, then run one short streaming request for each model family:

```bash
pi remove npm:pi-xai-oauth && pi install .
pi
```

Then, in the pi TUI:

```text
/login xai-auth
```

After login completes, from your shell run:

```bash
pi -p --model grok-4.5 "Reply exactly: OAUTH_PROXY_OK"
pi -p --model grok-4.3 "Reply exactly: OAUTH_PROXY_OK"
pi -p --model grok-4.20-0309-reasoning "Reply exactly: OAUTH_PROXY_OK"
pi -p --model grok-build "Reply exactly: OAUTH_PROXY_OK"
pi -p --model grok-composer-2.5-fast "Reply exactly: OAUTH_PROXY_OK"
```

Expected passing result for this manual smoke test: each command returns `OAUTH_PROXY_OK` without an API-team credit or spending-limit error. Then verify the separate direct Responses helper in a Grok 4.5 TUI session:

```text
/xai-tools enable xai_generate_text
Use xai_generate_text with model grok-4.5 and prompt "Reply exactly: DIRECT_OAUTH_PROXY_OK".
```

Do not enable `xai_generate_image` for this smoke test. Image generation intentionally uses the direct public Images endpoint, is billed/limited separately, and is not evidence for subscription-only Responses routing. Never print or record OAuth tokens while testing.

### Project Structure

```
pi-xai-oauth/
├── extensions/
│   ├── xai-oauth.ts          # Thin provider/tools entrypoint
│   └── xai/                  # Domain modules: OAuth, auth, models, payloads, tools
│       ├── auth.ts           # Pi/Grok credential reuse + token resolution
│       ├── catalog.ts        # Authenticated /models-v2 normalization + atomic LKG cache
│       ├── constants.ts      # URLs, OAuth constants, catalog bounds, defaults
│       ├── models.ts         # Curated fallback/known metadata + compatibility helpers
│       ├── oauth.ts          # Browser/device selection, PKCE login, refresh, callbacks
│       ├── device-auth.ts    # Pinned device initiation + bounded cancellable polling
│       ├── oidc.ts           # Pinned browser discovery/JWKS + ID-token validation
│       ├── payload.ts        # xAI Responses payload normalization
│       ├── responses.ts      # xAI request + streaming helpers
│       ├── routing.ts        # Credential-aware Responses and Images endpoints
│       ├── wire.ts           # Route-aware headers, scrubbing, identity, safe errors
│       ├── image-edit.ts     # Bounded edit request/response orchestration
│       ├── media/            # Reusable strict media parsing, compression, paths, and storage
│       └── tools/            # Custom xAI tools + Grok-native tool adapters
├── bin/
│   └── setup.js              # One-command setup (npx pi-xai-oauth)
├── compatibility/
│   ├── pi-versions.json      # Peer range plus exact minimum/latest CI policy
│   └── grok-build-wire-protocol.md # Pinned xAI route/header review
├── tests/                     # Focused typed Vitest domain suites
│   ├── fixtures/              # Isolated ExtensionAPI, OAuth, fetch, model, and temp fixtures
│   ├── catalog/               # Normalization, authenticated fetch, and cache policy
│   ├── oauth/                 # Browser/device/OIDC/refresh/cancellation/AuthStorage
│   ├── provider/              # Registration, routing, credentials, lifecycle, and races
│   ├── responses/             # Payload, stream, error, routing, and image transport
│   ├── images/                # Codec budgets and Images tool behavior
│   ├── media/                 # Strict media/path/compression/storage primitives
│   ├── tools/                 # Network lifecycle, commands, custom tools, and Grok-native adapters
│   └── setup/                 # Installer/settings behavior
├── scripts/
│   ├── run-compatibility-matrix.js # Clean packed exact-version test/typecheck runner
│   ├── verify-compatibility.js # Range/lock/registry/pack/unsupported-peer checks
│   └── verify-extension-loader.mjs # Small real Pi loader integration smoke
├── vitest.config.ts           # Node isolation and measured V8 coverage floors
├── .github/workflows/ci.yml  # PR/main policy and exact Pi boundary matrix
├── .scaffold/                # Persistent agent state (plan, progress, etc.)
├── AGENTS.md                 # AI agent operations manual
├── package.json
├── tsconfig.json
└── README.md
```

### Compatibility updates and publishing

`compatibility/pi-versions.json` is the single policy source for the peer range and exact CI endpoints. Normal development stays pinned exactly to the checked-in `latest` release; the minimum is tested only in a clean extracted tarball so the repository lock cannot mask version drift.

When a new Pi patch appears inside the current range:

1. Review both Pi package release notes.
2. Evaluate it without changing the published claim: `node scripts/run-compatibility-matrix.js X.Y.Z --candidate`.
3. If it passes, update `latest`, both exact Pi dev dependencies, and the lockfile together.
4. Run `npm run compatibility:check` and `npm run compatibility:boundaries`, then record the result in CHANGELOG.

For a new pre-1.0 minor line, keep the existing upper bound while running the candidate command. Widen the upper bound only after both Pi packages at that exact release pass the packed tests/typecheck and independent review. If raising the minimum, move the older sentinel to the immediately previous published release and document the support break. Never widen based only on Dependabot, typecheck, or a lockfile refresh.

Before publishing, first bump `package.json` and `package-lock.json` together and finalize CHANGELOG. Then validate the exact release tree:

```bash
npm test
npm run typecheck
npm run compatibility:check
npm run compatibility:boundaries
npm pack --dry-run --json
git diff --check
npm publish

# Users update with:
# pi update npm:pi-xai-oauth
```

---

## Contributing

PRs welcome! If you find issues or want to improve the OAuth flow, feel free to open an issue or pull request on [GitHub](https://github.com/BlockedPath/pi-xai-oauth).

---
*Powered by Grok 4.5 — flagship reasoning, agentic coding, and the full xAI API.*
