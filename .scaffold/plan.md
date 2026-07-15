# Plan: Fix disable clearing all authorized tools (issue #60)

**Branch:** cursor/fix-disable-clears-all-tools-c1c0

**Goal:** `/xai-tools disable <tool>` without an active xAI model must remove only the named tool from the opt-in set and active-tool registry, preserving every other authorized network tool.

## Steps
- [x] Reproduce: `setXaiNetworkToolActive` starts from an empty set and deletes the WeakMap scope when `!xaiModel`
- [x] Fix `setXaiNetworkToolActive` to always copy `previousSelection` and persist remaining authorizations
- [x] Add regression in `scripts/verify-extension.js` for multi-tool disable without an xAI command model
- [x] Run `npm run typecheck` and `npm test`
- [x] Commit, push, open PR
