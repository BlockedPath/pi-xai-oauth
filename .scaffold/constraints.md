# Pi 1.0.0 Compatibility Constraints

- Preserve all existing supported Pi intervals and the known-broken 0.85.0 exclusion.
- Keep unreviewed 0.99 releases outside the supported range; strict negative peer installs cover both internal gaps and upper/lower sentinels.
- Keep aligned peers bounded and development pins exact at policy.latest.
- Run clean packed minimum/latest tests and typecheck without the repository lockfile.
- Use no live xAI requests or real user credentials during validation; isolate both HOME and USERPROFILE.
- Preserve Unix mode assertions and path-containment behavior. No formatter churn or unrelated changes.
- No publication, merge, or credentials changes authorized in this task.
