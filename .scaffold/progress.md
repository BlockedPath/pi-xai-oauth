# Execution Progress — Code review follow-up

**Branch:** `fix/setup-seeding-and-catalog-catch`
**Scope:** Fixes for two findings from a full read-only review of the extension, plus the dependency drift that was blocking the boundary gate.

## Completed

- [x] Reviewed the extension across four parallel read-only domains (OAuth/security, catalog/provider, tools/media, usage/hygiene) and independently verified every high-severity claim against the source before accepting it.
- [x] Downgraded two overstated reviewer findings after verification: `savePrivateStreamedOutput` path escape (both shipped callers pass literals) and the `search_replace` no-follow gap (requires a hostile process already inside the workspace).
- [x] `fix(setup)` `c293641`..`9b1b73a`: scoped `defaultModel`/`defaultThinkingLevel` seeding by ownership so an existing non-xAI provider keeps its own model selection. Corrected the regression that asserted the destructive overwrite; added blank-fill vs deliberate-choice coverage.
- [x] `fix(catalog)` `2e5bbb9`: moved the login `onProgress` call out of the `try` whose `catch` swaps in the curated fallback, so a throwing host UI callback can no longer discard a validated remote entitlement snapshot. Confirmed the new regression fails against the previous control flow.
- [x] `fix(deps)` `c293641`: widened the `@napi-rs/wasm-runtime` override from exact `1.1.6` to `^1.2.0`. Upstream `@rolldown/binding-wasm32-wasi@1.2.1` now requires `@emnapi/core@2.0.0-alpha.3` + `@napi-rs/wasm-runtime@^1.2.0`, which ERESOLVE-failed every clean boundary install under `--strict-peer-deps`. Verified the failure reproduced on unmodified `main`, so it was pre-existing drift and not caused by this work. Resynced `package-lock.json` for CI's `npm ci`.
- [x] Caught and reverted an editor auto-format that had rewritten all of `extensions/xai-oauth.ts` from spaces to tabs (537-line diff, and a suite slowdown from 6.3s to 21s). Re-applied the logical change as a minimal 21-line diff.
- [x] Gates: `npm test` 50 files / **605 tests** pass, `npm run typecheck` clean, loader smoke ok, `npm run compatibility:check` ok (205-file packed manifest, unsupported peers correctly rejected), and **both exact boundaries pass** — Pi 0.80.1 ok and Pi 0.82.1 ok. `git diff --check` clean.

## In Progress

- None.

## Next

Push the branch and open a PR. Reviewed-but-unfixed findings, in priority order, are available to pick up:

1. `extensions/xai/images.ts:91-171` — inline-image budget is output-side only; no cap on per-image encoded size, image count, or clone recursion depth before `Buffer.from` decodes each original. (medium)
2. `extensions/xai/images.ts:78-80` — `http(s)` image URLs forwarded to the backend with no host/IP/redirect policy, unlike the well-pinned `video-download.ts`. (medium)
3. `extensions/xai/bounded-body.ts:129-159` — byte-bounded but has no signal or wall-clock deadline, so a slow drip can hang forever. (medium)
4. `extensions/xai/media/output-storage.ts:91-112` — constrain `stemPrefix`/`extension` to a safe filename token; latent, not currently reachable. (low)
5. `extensions/xai/tools/grok-native.ts:822-828`, `:624-638` — write/read through the checked descriptor instead of reopening by pathname. (low)
6. `oauth.ts:164-165,574-579` (`expires === 0` truthiness), `oauth.ts:345-356` / `oidc.ts:60-68` (no timeout/bounded reader), `catalog.ts:428-439` (cached `thinkingLevelMap` values unvalidated), `responses.ts:187-198` (two terminal events). (low)
7. `.github/workflows/ci.yml:22-23,60-61` — actions on mutable major tags; no `github-actions` Dependabot entry. (low)

Local note: `npm run compatibility:check` walks the working tree and will fail with `Packed package is missing tests/.DS_Store` if macOS Finder artifacts are present. They are gitignored and absent in Linux CI; `find . -name .DS_Store -not -path "./node_modules/*" -delete` clears it.
