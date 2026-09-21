# Implementation Plan — Issue #220: same-turn reasoning recovery

**Branch:** `feature/issue-220-reasoning-retry`
**Base:** `6b619c5`
**Issue:** https://github.com/BlockedPath/pi-xai-oauth/issues/220

## Scope and invariants

Recover a classified encrypted-reasoning mismatch within one `xai-auth` turn. Retry at most once, only when the final outbound payload contained encrypted reasoning, no assistant content was forwarded, and cancellation has not occurred. Preserve visible/tool-result history, exact-target replay protection, next-turn omission, opaque reasoning storage, and fixed redacted guidance.

- Parent is sole implementation writer; parallel read-only scout/reviewer completed before implementation.
- Discard only the failed attempt's buffered start/error. Any content event disables retry.
- Repeat caller hooks and local guards; strip rejected reasoning after hooks. Preserve the encrypted-output include policy.
- Keep redirect protection through both attempts; stable session/conversation IDs and fresh request IDs.
- Failed retry transport returns fixed guidance; local validation and aborts remain distinct.
- No changes to OAuth credentials, catalog policy, direct Responses retries, Pi core, or unrelated tools.

## Steps

1. [x] Identify the issue and establish a failing real-delegate regression.
2. [x] Consume parallel test planning and pre-implementation review.
3. [x] Implement bounded recovery and pass focused tests/typecheck/LSP.
4. [x] Document the runtime behavior and update the Unreleased changelog.
5. [x] Run full tests, coverage, and clean packed Pi 0.80.1/0.85.1 boundaries.
6. [x] Inspect the final scoped diff and record evidence in progress.md.

Follow-up delivery is authorized: commit the reviewed changes, push this feature branch, and open a PR closing #220. Do not merge or release.
