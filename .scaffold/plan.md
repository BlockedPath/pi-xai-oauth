# Pi 1.0.0 Compatibility Plan

Branch: `feature/pi-1-support`; base: `main` at `f8f28e4`.

The user requested Pi 1.0.0 support and tests, with parallel subagents authorized. Preserve existing supported releases and the Pi 0.85.0 exclusion. Do not claim untested pre-1.0 releases, publish, merge, or make live xAI requests.

1. Parallel research: upstream API review (`pi_api_review`) and Windows test diagnosis (`windows_diagnosis`).
2. Chain review: reviewer validates scope before implementation (`plan_review`).
3. Root owns compatibility policy, exact package/lock metadata, policy tests, README/CHANGELOG, and scaffold progress.
4. Delegate Windows script/test fixes after diagnosis, with disjoint ownership.
5. Validate Pi 1.0.0 candidate, full tests/typecheck/package checks, and clean packed boundaries at 0.80.1 and 1.0.0. Preserve strict negative peer-resolution fixtures.
6. Final reviewer checks diff and validation; report local changes and any remaining limitations.

All six steps completed. Full tests, typecheck, compatibility/mirror/negative-peer checks and both exact packed boundaries passed; final reviewer found no actionable issues. Leave changes local on the feature branch for user review.
