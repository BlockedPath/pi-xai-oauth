# Implementation Plan — Pi 0.84.1 compatibility

**Branch:** `feature/pi-0.84.1-compat`

## Goal

Support aligned `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` releases through exact Pi 0.84.1 while preserving the exact Pi 0.80.1 minimum boundary.

## Confirmed public seams

1. OAuth refresh accepts Pi's concrete abort signal, uses it for token exchange, and lets Pi atomically persist rotated credentials.
2. Provider catalog re-registration/publication remains exact across the minimum and newest ModelRuntime contracts.
3. A clean packed package passes full tests, loader smoke, and TypeScript at exact 0.80.1 and 0.84.1.

## Vertical slices

1. [x] Add a failing refresh-signal regression; propagate the signal through `refreshToken`.
2. [x] Adapt real-runtime cancellation/catalog tests to the public Pi 0.80.1 and 0.84.1 contracts without weakening credential/catalog assertions.
3. [x] Widen aligned peers to `<0.85.0`, pin exact development dependencies/latest policy to 0.84.1, and update the lockfile.
4. [x] Update README, changelog, compatibility guidance, and persistent progress.
5. [x] Run focused diagnostics/tests, full gates, and both exact packed boundaries.
6. [x] Run independent correctness and standards/spec review; address confirmed findings and rerun affected gates.

## Non-goals

- No changes to xAI endpoints, scopes, catalog entitlement policy, or Responses routing.
- No core Pi modifications.
- No claim beyond Pi 0.84.x until a later line passes the same candidate process.
