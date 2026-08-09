# Implementation Plan — GitHub Packages mirror

**Branch:** `feature/github-packages-mirror`

## Goal

Publish each validated release to both npmjs as `pi-xai-oauth` and GitHub Packages as `@blockedpath/pi-xai-oauth`, without changing extension behavior or allowing duplicate registry aliases to register conflicting tools.

## Confirmed public seams

1. npmjs remains the canonical, unauthenticated public installation path.
2. GitHub Packages receives a lowercase scoped mirror built from the exact canonical tarball and authenticated with the repository `GITHUB_TOKEN`.
3. Setup derives its active distribution name from the installed manifest and treats npmjs, GitHub Packages, and local copies as aliases of one extension.
4. Release retries are safe when one registry succeeded and the other failed.
5. Version 1.4.2 is the first dual-published release; immutable 1.4.1 artifacts are not rewritten.

## Vertical slices

1. [x] Confirm GitHub Packages scope, authentication, token, and workflow permission requirements from official documentation.
2. [x] Make setup distribution-aware and add duplicate-alias regressions.
3. [x] Add deterministic canonical-tarball-to-scoped-mirror preparation and parity verification.
4. [x] Extend CI and GitHub Release publishing to validate and publish both registries idempotently.
5. [x] Bump and document release 1.4.2, including authenticated GitHub Packages installation.
6. [x] Run full local gates, exact packed boundaries, and independent review.
7. [x] Commit, push, and open the 1.4.2 dual-publishing pull request.

## Non-goals

- No replacement or renaming of the canonical npmjs package.
- No duplicate installation of both distributions in one Pi configuration.
- No PAT stored in GitHub Actions; local GitHub Packages consumers manage their own classic PAT with `read:packages`.
- No changes to OAuth, catalog entitlement, Responses routing, or xAI transport behavior.
