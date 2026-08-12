# AGENTS.md — AI Agent Operations Manual for pi-xai-oauth

> **For AI coding agents only.** Keep this file machine-readable and concise. Human-facing docs live in README.md.

## Project Overview

pi-xai-oauth is a pi-package that registers the optional xAI OAuth provider (`xai-auth`) and the authenticated account's OAuth-visible Grok model catalog, with Grok 4.6 as the curated offline fallback. Opt-in network tools and `/xai-usage` also work with Pi's built-in `xai` SuperGrok/X Premium chat provider; setup seeds `defaultProvider: xai` only when unset and never overwrites an existing provider choice.

Core flow: `bin/setup.js` → `pi install` → bounded catalog selection in `extensions/xai/catalog.ts` → provider registration in `extensions/xai-oauth.ts` → browser PKCE or bounded device authorization in `extensions/xai/oauth.ts` / `extensions/xai/device-auth.ts` → pinned browser OIDC/JWKS validation in `extensions/xai/oidc.ts` → streaming via xAI API helpers in `extensions/xai/responses.ts`; explicit revision-pinned subscription usage lives in `extensions/xai/usage.ts`.

## Key Commands (Exact, Copy-Paste Ready)

- Install / setup: `node bin/setup.js` or `npm run setup`
- Install as pi extension: `pi install npm:pi-xai-oauth`
- Full policy/unit/loader gate: `npm test`
- Focused Vitest suite: `npm run test:unit -- tests/oauth/browser-login.test.ts`
- V8 coverage: `npm run test:coverage`
- Real Pi loader smoke: `npm run test:loader`
- Run TypeScript: `npm run typecheck` (production, tests, fixtures, config)
- Verify Pi policy/package metadata: `npm run compatibility:check`
- Verify exact packed Pi boundaries: `npm run compatibility:boundaries`
- Verify the scoped GitHub Packages mirror: `node scripts/verify-github-package.js`
- Evaluate an unadvertised Pi candidate: `node scripts/run-compatibility-matrix.js X.Y.Z --candidate`
- Git: Always work on feature branches and confirm the active branch before edits.

## Architecture & Boundaries (MUST / MUST NOT)

**MUST:**

- Register providers via `pi.registerProvider("xai-auth", { ... })`
- Keep browser PKCE S256 with local callback server as the first/default login method
- Offer device authorization through pi's native selector/device-code callbacks for remote/headless human login
- Pin the device and token endpoints; wait before polling; honor interval plus cumulative slow-down; bound expiry; propagate cancellation
- Require matching state for every HTTP or pasted browser authorization callback before token exchange
- Validate retained fresh-login ID tokens against pinned first-party discovery/JWKS, ES256, issuer, audience, expiry, and nonce
- Support reasoning levels: none / low / medium / high
- Reuse `~/.grok/auth.json` when possible without deleting or revoking it
- Fetch OAuth-visible models only from the pinned authenticated CLI proxy `/models-v2` endpoint
- Treat successful catalog responses as exact entitlement state; additions appear and removals disappear
- Keep the normalized token-free catalog cache atomic and apply the documented TTL/stale/fallback policy
- Preserve known model metadata and compatibility behavior without inventing unentitled model families; known aliases and independently verified OAuth request slugs may be advertised only while their entitlement source is present at registration/runtime (cache stays exact)
- Keep both Pi peers aligned to the checked-in bounded range in `compatibility/pi-versions.json`
- Keep npmjs `pi-xai-oauth` canonical and publish GitHub Packages only as the exact scoped mirror `@blockedpath/pi-xai-oauth`; setup must treat both names as aliases and prevent duplicate registration
- Install/report exact Pi matrix versions from a clean packed package; never reuse the repository lockfile for boundary jobs
- Keep normal Pi dev dependencies exact at the policy's latest tested release and review candidate releases before widening support
- Resolve `x-userid` transiently from the pinned authenticated CLI-proxy `/user` endpoint before any billing request
- Keep `/xai-usage` explicit, and keep its optional status off by default, session-scoped, bounded, and inactive outside xAI models

**MUST NOT:**

- Hardcode API keys (use OAuth only)
- Accept raw authorization codes or callbacks with missing/mismatched state
- Trust arbitrary `*.x.ai` discovery, device, token, verification, or JWKS endpoints
- Log or reflect authorization codes, opaque device codes, tokens, PKCE verifiers, state, nonce, device/token response bodies, or authenticated request headers
- Cache raw `/models-v2` responses, credentials, identity fields, endpoint URLs, or known API-key-only models
- Persist, cache, log, or display `/user` identity, authenticated usage headers, or raw authenticated usage bodies
- Send `/billing?format=credits` when the transient authenticated `/user` lookup is missing, malformed, cancelled, oversized, redirected, or unsuccessful
- Trust catalog-provided endpoints or route non-Responses models through the OAuth provider
- Delete or revoke existing user credentials during validation
- Modify core pi-coding-agent internals
- Touch unrelated extensions or skills
- Skip error handling on OAuth refresh

## File Structure & Wayfinding

```
pi-xai-oauth/
├── bin/
│   └── setup.js          # Installer + settings seeder (native xai default when unset)
├── extensions/
│   ├── xai-oauth.ts      # Thin entrypoint: provider registration + tool orchestration
│   └── xai/              # Focused implementation modules
│       ├── catalog.ts    # Authenticated catalog normalization + atomic token-free cache
│       ├── constants.ts  # URLs, defaults, OAuth/catalog constants
│       ├── models.ts     # Curated fallback/known metadata + compatibility helpers
│       ├── oauth.ts      # Browser/device selection, PKCE login, refresh, callback helpers
│       ├── device-auth.ts # Pinned device initiation + bounded cancellable polling
│       ├── oidc.ts       # Pinned browser discovery/JWKS + ID-token validation
│       ├── auth.ts       # Credential reuse + token resolution helpers
│       ├── payload.ts    # Responses payload normalization
│       ├── responses.ts  # xAI request/stream helpers
│       ├── routing.ts    # Credential-aware Responses/Images endpoint routing
│       ├── wire.ts       # Route-aware headers, scrubbing, identity, safe errors
│       ├── image-edit.ts # Bounded pinned image-edit orchestration
│       ├── media/        # Reusable strict media/path/compression/storage primitives
│       ├── usage.ts      # Explicit bounded identity-first subscription usage command/status
│       └── tools/        # Custom xAI tools + collision-free Grok-native adapters
├── compatibility/
│   ├── pi-versions.json # Peer range plus exact minimum/latest matrix policy
│   └── grok-build-wire-protocol.md # Pinned xAI route/header review procedure
├── tests/                    # Focused typed Vitest domain suites + isolated fixtures
├── vitest.config.ts          # Node isolation and measured V8 coverage floors
├── scripts/
│   ├── verify-extension-loader.mjs # Small real Pi loader smoke
│   ├── verify-compatibility.js # Policy/range/registry/pack/unsupported-peer checks
│   ├── prepare-github-package.js # Exact scoped mirror staging for GitHub Packages
│   ├── verify-github-package.js # Mirror name/registry/version/setup parity gate
│   └── run-compatibility-matrix.js # Clean packed exact-version test/typecheck runner
├── .github/workflows/
│   └── ci.yml           # PR/main policy and exact Pi boundary matrix
├── package.json
├── tsconfig.json
├── README.md
├── AGENTS.md             # This file
└── .scaffold/            # Persistent agent state (auto-generated on init)
    ├── plan.md
    ├── constraints.md
    ├── progress.md
    ├── context.md
    └── (custom overrides here)
```

Start any task by reading:

1. `extensions/xai-oauth.ts` (provider entrypoint)
2. Relevant `extensions/xai/` domain module for the task
3. `bin/setup.js`
4. This AGENTS.md

## Style & Quality Rules

- Use TypeScript strict mode
- Prefer async/await for OAuth and API calls
- Add JSDoc for all exported functions
- Keep OAuth callback server minimal and secure
- Keep raw browser authorization codes rejected; direct users to device login or a complete matching-state redirect URL
- Never log OAuth codes, opaque device codes, tokens, device/token response bodies, verifiers, state, nonce, catalog request headers, or raw authenticated catalog bodies
- Never retain a device-flow ID token without a device-specific validation policy; browser ID tokens keep nonce-bound OIDC validation
- Keep caller/model reserved headers scrubbed before appending the route-specific contract; never reflect raw transport error bodies
- Reject malformed, hidden, unsupported-backend, secret-bearing, and known API-key-only catalog entries
- Keep startup catalog network behavior bounded and use pi's credential lock for expired stored-token refresh
- Keep usage redirects, timeouts, response bytes, JSON complexity, history counts, and numeric ranges bounded; redact every usage error
- Clear optional usage status on model, provider, account, and session changes, and never refresh it for non-xAI models
- Keep compatibility policy/registry/pack/resolver verification in plain Node; behavior tests use focused Vitest suites
- Isolate fetch, timers, environment, temp HOME/filesystem, module state, runtime models, credentials, and active-tool registries per test
- Keep real callback tests sequential with real timers and guaranteed listener cleanup
- Use strict peer resolution for supported versions; `--force` is allowed only in isolated negative fixtures that assert npm peer warnings

## Safety Gates

- Before any file edit: run `git status` and confirm on correct branch
- Before committing: ensure `npm test`, `npm run typecheck`, and both exact compatibility boundaries pass
- For multi-agent work: always use the subagent tool with explicit parallel or chain mode
- External state lives in `.scaffold/` — update progress.md after every major step

## Multi-Agent Workflow (Preferred)

When complex work is needed:

1. Use `subagent` in PARALLEL mode for research + planning
2. Delegate to specialized agents (researcher, planner, reviewer, worker)
3. Save outputs to `.scaffold/` files
4. Review with `reviewer` agent before implementation

## Persistent State (Use These Files)

- `.scaffold/plan.md` — Current implementation plan with steps and owners
- `.scaffold/constraints.md` — Hard rules and boundaries
- `.scaffold/progress.md` — What has been done + next actions
- `.scaffold/context.md` — Shared context for handoff between agents

## Next Steps When Starting Fresh

1. Read this AGENTS.md + README.md
2. Run `git checkout -b feature/your-task`
3. Check `.scaffold/plan.md` for current work
4. Use parallel subagents for heavy lifting

This file should be updated whenever architecture, commands, or rules change.

## Cursor Cloud specific instructions

This repo is a **pi extension package (a library/CLI), not a standalone server**. There is nothing to "boot" — dependency install happens automatically via the startup update script (`npm ci`). Node engine note: the pi peer deps request Node `>=22.19.0` and the pod ships `22.14.0`, so `npm ci` prints `EBADENGINE` warnings; these are non-blocking — typecheck, tests, and extension load all pass.

- Build / typecheck gate: `npm run typecheck` (`tsc --noEmit`). There is **no separate lint tool** configured; typecheck is the static gate.
- Tests: `npm test` runs compatibility policy, focused Vitest regressions, and the small real Pi loader smoke. Use `npm run test:coverage` for V8 output and `npm run test:unit -- <path> -t <name>` for focus.
- Running the "app": full end-to-end use (`pi`, `/login xai` and/or `/login xai-auth`, live Grok streaming) needs the external `pi` CLI, an interactive browser OAuth flow, and a real xAI/Grok account, so it is **not runnable headless** here. Offline behavior lives in focused `tests/` suites with isolated fixtures; `npm run test:loader` exercises the real Pi loader without live xAI access. Catalog fixtures live under `tests/fixtures/models-v2/`.
- Any temporary demo script that imports deps must live inside the repo root (so it resolves `node_modules`), not `/tmp`.
