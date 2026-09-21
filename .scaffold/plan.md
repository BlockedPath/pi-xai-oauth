# Implementation Plan — Grok 4.7 and Pi 0.86.1 support

**Branch:** `feature/grok-4-7`

## Scope and invariants

Add known metadata and reasoning support for `grok-4.7` using official xAI documentation. The authenticated OAuth catalog remains authoritative; public availability is not proof of account entitlement. Keep Grok 4.6 as the setup/offline fallback and preserve existing selections, aliases, transport, and prior models. Do not add unverified Fast routing or make live generation requests. Credential access was limited to the two separately authorized read-only catalog diagnostics described below.

## Steps (parent-owned)

1. [x] Inspect existing registration, metadata, codec, tools, setup, and tests; verify official docs.
2. [x] Add regressions for metadata, entitlement boundaries, authenticated overrides, registration, and reasoning dispatch.
3. [x] Add Grok 4.7 metadata, minimal-to-low compatibility, and high-by-default custom text generation.
4. [x] Document capability/pricing sources, output-limit placeholder, and unchanged defaults.
5. [x] Run full tests, typecheck, active LSP, and clean packed Pi 0.80.1/0.85.1 boundaries.
6. [x] Review Grok 4.7 diff and record validation evidence in progress.md.

## Approved Pi 0.86.1 follow-up

After clarification, the user explicitly selected “Include Pi 0.86.1 (Recommended)”: fix transcript-context compatibility, update the bounded peer range, and validate old/new Pi versions. Parent remains sole writer.

1. [x] Reproduce candidate failure using the clean packed runner: tests/loader pass, but responses.ts passes unbranded Context to the new TranscriptContext delegate.
2. [x] Consume read-only upstream contract research and independent pre-implementation review (workflow `f5e7b100-5e32-494e-8e0e-3bc698f78d73`). Parent remains sole writer.
3. [x] Preserve new transcript system/tools state and legacy context support with a tested adapter; do not hide the break with an unchecked cast.
4. [x] Pass 0.86.0 and 0.86.1 candidates; align bounded policy/peers/dev pins/lock/docs, retaining 0.80.1 minimum and 0.85.0 exclusion. CI already derives its matrix from policy; no workflow edit needed.
5. [x] Run full tests/typecheck/coverage, strict policy/package/resolver checks, active LSP, parent diff review, and both new packed boundaries. See progress.md for evidence and intentional skip counts.

## Delivery authorization

After validation, the user requested a commit and PR; an initial local commit was created and later amended into published commit `3a545ff2aa26440fc5c12a0d24ff097f8c6077d4`. Before push, the user paused delivery because Grok 4.7 was missing from the selector. Two separately authorized read-only catalog probes found the normalization bug: a valid 1M completion limit exceeded the 500K context window and caused the entire model to be discarded.

- [x] Reproduce the exact allowlisted metadata shape across normalization, cache refresh/reload, and provider registration.
- [x] Keep absolute completion bounds and clamp valid independent limits to context instead of rejecting the model; focused tests and typecheck pass.
- [x] Run full revalidation: 849 tests, loader, typecheck, coverage, policy/pack/mirror checks, static diagnostics, and Pi 0.80.1/0.86.1 packed boundaries.
- [x] User-provided screenshot confirms Grok 4.7 is visible under `xai-auth` after the fix.

PR #223 is open from the published feature branch. The user now authorizes merging if CI and review findings are clear, then syncing local `main`. Address the verified `xhigh` tool-schema finding and stale delivery note, rerun all gates, push the follow-up, and require fresh CI before merging. Do not upload the user's screenshot, publish a package, or make additional live probes.
