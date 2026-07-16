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

This package adds xAI's **account-specific OAuth model catalog** to pi, with **Grok 4.5** as the offline fallback/default, proper OAuth login, automatic token refresh, and a suite of custom tools (`xai_generate_text`, `xai_web_search`, `xai_x_search`, etc.). Models such as Grok Build, Composer, Grok 4.3, and Grok 4.20 appear only when xAI returns them for the authenticated account.

> **Latest release:** `pi-xai-oauth` **1.3.5** keeps the highlighted `/xai-tools` row in place after toggling, so multiple tools can be configured without repeatedly navigating from the top. Version 1.3.4 made every network-backed xAI helper an explicit, session-scoped opt-in through `/xai-tools`, including paid image generation, and made disabled tools fail before OAuth credential lookup or network access. Existing npm installs should run `pi update npm:pi-xai-oauth`; local checkout installs should keep only one copy with `pi remove npm:pi-xai-oauth && pi install .`.
>
> **Compatibility note:** 1.2.4+ supports pi 0.79.8+'s OpenAI Responses API guard for Grok/xAI streaming.

See [CHANGELOG.md](CHANGELOG.md) for the complete version-by-version feature and fix history.

---

## Table of Contents

- [✨ New: Grok 4.5](#-new-grok-45)
- [Features](#features)
- [Changelog](CHANGELOG.md)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Authentication](#authentication)
- [Usage](#usage)
  - [Switching Models](#switching-models)
  - [Reasoning / Thinking Levels](#reasoning--thinking-levels)
- [Custom Tools](#custom-tools)
- [Usage limits (`/xai-usage`)](#usage-limits-xai-usage)
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
- **Long-context metadata when entitled** — known Grok 4.3 behavior is preserved when xAI returns it, with authenticated limits taking precedence
- **Authenticated model catalog** — fetches the OAuth-visible `/models-v2` list from the official CLI proxy, so additions and removals track the signed-in account
- **Coding models when entitled** — Grok Build, Composer, and other models appear only when xAI includes them in the account catalog
- **Reasoning support** — parses supplied reasoning capability and thinking levels while preserving known model compatibility
- **Bounded last-known-good cache** — avoids routine startup delay and falls back safely when discovery is offline or unavailable
- **Custom xAI tools** — generate text, web search, X/Twitter search, multi-agent research, code analysis
- **Credential-aware Responses routing** — OAuth/session traffic uses the official `https://cli-chat-proxy.grok.com/v1` endpoint for every Grok model; the public `api.x.ai` Responses endpoint is reserved for a future explicit API-key path

> **✅ Verified (May 2026)**: All custom xAI tools (`xai_generate_text`, `xai_x_search`, `xai_web_search`, `xai_code_execution`, `xai_critique`, `xai_multi_agent`, `xai_deep_research`, image tools, etc.) have been tested end-to-end after the OAuth + payload repair. The provider now correctly handles mixed-model requests and native xAI tool shapes.

---

## How It Works

`pi-xai-oauth` registers an OAuth provider called `xai-auth` in pi's provider registry. When you launch `pi` and run `/login xai-auth`, pi offers two native login methods:

- **Browser login (default):** starts a loopback callback listener, opens xAI authorization with PKCE S256, requires matching state for HTTP or pasted full-redirect callbacks, and verifies the fresh ID token against the pinned issuer/JWKS, ES256 policy, audience, expiry, and nonce.
- **Device code login:** requests a challenge from the pinned first-party device endpoint, shows the verification URL and user code through pi's device UI, and polls the pinned token endpoint only after the server interval. It handles pending/slow-down, denial, expiry, cancellation, malformed responses, and a bounded timeout without displaying the opaque device code or token responses.

Only a completed selected login returns access + refresh credentials for pi to persist. It then performs a bounded authenticated `GET https://cli-chat-proxy.grok.com/v1/models-v2`, filters unsafe/API-key-only entries, and immediately replaces the provider catalog. All OAuth-backed Responses traffic uses xAI's session-token proxy; proxy requests identify this package and include the required auth, client-mode, request, conversation, session, and model metadata.

Browser login still supports the **complete redirect URL** paste fallback when localhost is unreachable. The URL must contain the matching OAuth `state`; raw authorization codes are not accepted. Device login is the cleaner choice when the browser cannot reach the pi process.

---

## Installation

### One-command install (recommended)

```bash
npx pi-xai-oauth
```

This runs the setup script which:
1. Installs `npm:pi-xai-oauth` into pi
2. Sets `xai-auth` as your default provider
3. Sets `grok-4.5` as your default model
4. Enables `high` thinking level by default

### Manual install

```bash
pi install npm:pi-xai-oauth
```

Then optionally configure it as default:

```bash
# In ~/.pi/agent/settings.json:
{
  "defaultProvider": "xai-auth",
  "defaultModel": "grok-4.5",
  "defaultThinkingLevel": "high"
}
```

> **⚠️ Important: install only one copy**
>
> `pi-xai-oauth` registers fixed tool names such as `xai_generate_text`, `xai_web_search`, and `xai_x_search`. If you install more than one copy — for example `npm:pi-xai-oauth` plus a local checkout, or two different local checkouts — pi will fail to start with `Tool "xai_generate_text" conflicts with ...` errors.
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

### Switching Models

`/model` shows the current authenticated account's xAI catalog. A successful refresh is authoritative: newly returned models appear, removed models disappear, hidden entries are omitted, and known API-key-only models such as `grok-build-0.1` are never advertised through `xai-auth`.

Common catalog entries include:

| Model ID | Description |
|----------|-------------|
| `grok-4.5` | **Default and curated offline fallback.** xAI flagship; reasoning low (**fast**) / medium / high (default), 500K context, text+image. |
| `grok-4.3` | When entitled: full reasoning, with limits taken from the authenticated catalog. |
| `grok-build` | When entitled: Grok Build coding model with Cursor/Grok CLI tool compatibility. |
| `grok-composer-2.5-fast` | When entitled: Composer coding model with Cursor/Grok CLI tool compatibility. |
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
pi --model grok-4.3 "Use the 1M-context model"
pi --model grok-build "Implement this feature"
pi --model grok-composer-2.5-fast "Refactor this module"
pi --model grok-4.20-0309-non-reasoning "Quick answer"
```

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

The cache stores only normalized model definitions and timestamps. It never stores access/refresh/ID tokens, auth headers, raw endpoint responses, or account identity fields. Startup does not expose a previous account's fresh cache when no credential exists, and a credential-file modification newer than the cache forces discovery. If an exceptional filesystem error prevents replacing or deleting an old cache, a token-free `.invalidated` sidecar suppresses it until a later successful atomic write. A token-free cache still cannot distinguish an external account replacement that deliberately preserves the credential file's timestamp; in-product login always bypasses and replaces the cache.

### Reasoning / Thinking Levels

Grok 4.5, and Grok 4.3 when returned with reasoning support, expose configurable thinking levels via pi's `/think` command or `model:effort` syntax. There is **no separate `grok-4.5-fast` model** — on Grok 4.5, “fast mode” is **`reasoning_effort: "low"`** on the same model ID.

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

`grok-4.5` defaults to **high** when no effort is specified; reasoning **cannot be disabled** (`/think off` is not supported for this model). Every model actually returned and selected through the OAuth-only `xai-auth` catalog sends Responses traffic through xAI's Grok CLI session endpoint using the same X account OAuth token. When returned, Grok Build and Composer still receive their model-specific compatibility payloads, headers, and local tool shims. `grok-composer-2.5-fast` does not accept configurable reasoning effort. `grok-4.20-0309-reasoning` reasons automatically and does not accept a configurable effort parameter. `grok-4.20-multi-agent-0309` uses `medium` for 4 agents and `high` for 16 agents.

### Grok 4.5 source notes

Official xAI sources used for this catalog update:

- [Grok 4.5 guide](https://docs.x.ai/developers/grok-4-5) — model ID, API usage, reasoning levels, tools, and availability notes.
- [Grok 4.5 model details](https://docs.x.ai/developers/models/grok-4.5) — text+image input, 500K context window, cached input pricing, regions, and rate-limit snapshot.
- [Reasoning docs](https://docs.x.ai/developers/model-capabilities/text/reasoning) — `low` / `medium` / `high` reasoning effort, default `high`, and non-disableable reasoning.
- [Launch announcement](https://x.ai/news/grok-4-5) — coding/agentic benchmark notes, Grok Build/Cursor availability, and EU availability caveat.

No Grok 4.5-specific model card, label card, system card, paper, or official max-output-token limit was found in the xAI docs/news/data sources during this update. The package keeps the existing Grok Responses max-token ceiling as a placeholder until xAI publishes official model metadata for that field.

### Composer / Grok Build Tool Compatibility

Composer 2.5 and Grok Build are trained against Cursor/Grok CLI-style tool names. When either `grok-composer-2.5-fast` or `grok-build` is selected, this package automatically enables compatibility shims that map those tool calls onto pi's built-in tools:

| Cursor/Grok CLI tool | pi tool used underneath |
|----------------------|-------------------------|
| `Read` | `read` |
| `Write` | `write` |
| `StrReplace` / `Edit` | `edit` |
| `Delete` | workspace-safe file delete |
| `LS` | `ls` |
| `Grep` | `grep` |
| `Glob` | `find` |
| `Shell` | `bash` |
| `WebSearch` | xAI native web search |

The local filesystem and shell shims also normalize common Cursor argument names, such as `file_path`, `contents`, `old_string` / `new_string`, `query`, `include`, `glob_filter`, and `cmd`. They are enabled automatically for eligible Grok CLI models and disabled again when you switch back to models such as `grok-4.5` or `grok-4.3`. `WebSearch` is the exception: it sends an additional xAI request, so it remains inactive until you enable it through `/xai-tools`.

---

## Custom Tools

This package registers OAuth-backed custom tools that make additional xAI API requests. They appear alongside your other agent tools in the pi TUI, but all of them are **inactive by default**.

This opt-in boundary applies only to the extra tools below. Normal conversation with the selected `xai-auth` model works without enabling any of them.

| Tool | Category | Additional usage / cost risk |
|------|----------|------------------------------|
| `xai_generate_text` | Generation | Separate model-token usage |
| `xai_web_search` | Search | Model tokens plus native tool usage |
| `xai_x_search` | Search | Model tokens plus native tool usage |
| `xai_multi_agent` | Research | High/variable: 4 or 16 agents plus web/X tools |
| `xai_deep_research` | Research | High/variable model and web/X tool usage |
| `xai_code_execution` | Execution | Model tokens plus code-interpreter usage |
| `xai_generate_image` | Image generation | Charged per generated image; supports 1-4 images |
| `xai_analyze_image` | Vision | Separate model-token and image-input usage |
| `xai_critique` | Reasoning | Separate high-reasoning model-token usage |
| `WebSearch` | Search | Grok Build/Composer model tokens plus native tool usage |

**How to use them:** Select an `xai-auth` model, enable only the tool you want through `/xai-tools`, then explicitly request that tool in your prompt or agent workflow. Enabling a tool makes it available; it is not permission for the model to call it without user intent.

Every new session resets all network-backed tools to inactive. Switching to a non-xAI model disables them immediately, and switching back does not restore them. The Grok CLI local filesystem and shell shims are automatic because they do not create a separate xAI API request.

In the pi TUI, select an `xai-auth` model and run:

```text
/xai-tools
```

The picker shows each tool's category and cost-risk context, warns that calls may use xAI credits, and applies changes only to the current xAI session. Use ↑/↓ to move, Enter or Space to toggle a tool in place, and Escape when done; the highlighted row stays put after each toggle. You can also manage one tool directly:

```text
/xai-tools status
/xai-tools enable xai_web_search
/xai-tools disable xai_web_search
/xai-tools enable xai_generate_image
```

`WebSearch` appears in the picker only for Grok Build and Composer models. `/xai-tools` is owned by this package; it does not depend on pi's optional example `/tools` extension.

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

### `xai_web_search`
Opt-in search using xAI's native `web_search` tool and the active xAI model. Enable it through `/xai-tools` first.

```json
{
  "query": "Rust vs Go performance 2026"
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
Opt-in analysis of an image URL, data URL, or local `.png` / `.jpg` path with Grok vision. Enable it through `/xai-tools` first.

```json
{
  "image": "/Users/me/Desktop/screenshot.png",
  "question": "What error is visible?"
}
```

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

> **Note:** Every tool in this section makes a separate xAI request and can consume subscription allowances, credits, or rate limits. Responses-based helpers use the OAuth session proxy. Image generation is the intentional exception: matching official Grok Build behavior, it sends the OAuth bearer directly to `https://api.x.ai/v1/images/generations` and is charged per generated image. See [xAI pricing](https://docs.x.ai/developers/pricing) for current rates.

---


## Usage limits (`/xai-usage`)

Show your SuperGrok / Grok Build **account** weekly (or monthly) usage pool — the same billing surface as the official Grok Build CLI `/usage` command.

```text
/xai-usage            # show limit %, reset time, product breakdown
/xai-usage refresh    # force re-fetch (skip short cache)
/xai-usage manage     # print billing / upgrade URLs
```

- Footer status: `xAI Weekly N%` (or `xAI Monthly N%`) after session start
- Auto-refresh: once at session start, then every hour while the session is open
- Account-level pool (not per-model). Switching away from `xai-auth` does not change the number
- Manage credits in the browser: https://grok.com/?_s=usage

Requires `/login xai-auth` (or an existing `grok login` session). Uses the Grok CLI chat proxy billing endpoint; fail-soft if the payload changes.

## Quick Reference

| Action | Command |
|--------|---------|
| Install | `pi install npm:pi-xai-oauth` |
| One-command setup | `npx pi-xai-oauth` |
| Try ephemeral | `pi -e npm:pi-xai-oauth` |
| Authenticate | Launch `pi`, run `/login xai-auth`, then choose browser (default) or device code |
| Update | `pi update npm:pi-xai-oauth` |
| Remove | `pi remove npm:pi-xai-oauth` |
| List packages | `pi list` |
| Set default model | `/model grok-4.5` (in TUI) |
| Set thinking level | `/think high` (in TUI) |
| Manage outbound xAI tools | `/xai-tools` (in TUI) |
| SuperGrok weekly/monthly usage | `/xai-usage` (footer: `xAI Weekly N%`) |
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

This means xAI rejected a multimodal Responses `input` shape. Use the latest package version and restart pi or run `/reload`. The provider normalizes local `.png`/`.jpg` paths into `data:image/...;base64,...` URLs, adds image `detail`, moves system/developer text to top-level `instructions`, and rewrites image-bearing tool results so `function_call_output.output` stays text-only (xAI rejects arrays there).

> **Fixed in repair**: Requests from other providers (DeepSeek, OpenAI Codex, etc.) no longer get mutated by the xAI sanitation hook.

If you call `xai_generate_text` directly, `image_url` may be either:

- an `http(s)://...` URL
- a `data:image/png;base64,...` or `data:image/jpeg;base64,...` URL
- a local `.png`, `.jpg`, or `.jpeg` path, including shell-escaped paths like `/Users/me/My\\ Image.png`

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

**No.** This uses OAuth — the same authentication as the official Grok CLI and chat interface. You sign in with your xAI / Grok account credentials. No API key required. Responses requests use the OAuth session proxy; this package does not fall back to `XAI_API_KEY` or expose an API-key provider.

The paid `xai_generate_image` helper is a deliberate transport exception: the official Grok Build client sends both OAuth and BYOK Imagine requests directly to the public Images endpoint. This does not change normal chat or Responses-helper routing.

If you have the official Grok CLI installed and authenticated (`~/.grok/auth.json`), this package detects and reuses those credentials automatically.

### "Why is a model missing or still cached?"

The xAI model list is entitlement-aware. If a model is missing, the authenticated `/models-v2` response did not include a usable OAuth Responses entry, or discovery fell back to the curated offline catalog. Run `/login xai-auth` to force an account-bound refresh. `/reload` reloads the extension but intentionally reuses a cache younger than 15 minutes; after the TTL it performs a bounded refresh.

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

pi 0.79.8+ enforces an OpenAI Responses API guard. `pi-xai-oauth` 1.2.4+ handles that guard for Grok/xAI streaming; 1.3.3 fixes Responses transport resolution under pi 0.80's extension loader and includes Grok 4.5 as the default model. Version 1.3.4 makes all network-backed xAI helpers explicit opt-ins through `/xai-tools`, and **1.3.5** preserves the highlighted row while tools are toggled. If you installed the published npm package, update with the command above. If you are testing a local checkout instead, reinstall the checkout:

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

# Type-check
npm run typecheck

# Run verification tests
npm test

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
│       └── tools/            # Custom xAI tools + Cursor/Grok CLI shims
├── bin/
│   └── setup.js              # One-command setup (npx pi-xai-oauth)
├── scripts/
│   ├── verify-device-auth.js # Deterministic device protocol/timing/cancellation tests
│   ├── verify-catalog.js     # Catalog normalization/cache tests
│   ├── verify-extension.js   # Provider/OAuth/transport integration tests
│   └── verify-setup.js       # Installer/settings tests
├── .scaffold/                # Persistent agent state (plan, progress, etc.)
├── AGENTS.md                 # AI agent operations manual
├── package.json
├── tsconfig.json
└── README.md
```

### Publishing

```bash
# Bump version in package.json
# Then:
npm publish

# Users update with:
# pi update npm:pi-xai-oauth
```

---

## Contributing

PRs welcome! If you find issues or want to improve the OAuth flow, feel free to open an issue or pull request on [GitHub](https://github.com/BlockedPath/pi-xai-oauth).

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=BlockedPath/pi-xai-oauth&type=Date)](https://star-history.com/#BlockedPath/pi-xai-oauth&Date)

---

*Powered by Grok 4.5 — flagship reasoning, agentic coding, and the full xAI API.*
