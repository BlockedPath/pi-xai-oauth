# Candidate matrix (Claude) — `run-compatibility-matrix.js <v> --candidate` on the refactor tree

Every version installs with strict peers, and the real Pi loader smoke passes on all of them.

| Pi | Tests | Typecheck | First appearance |
|---|---|---|---|
| 0.84.2 (policy latest) | 663 ✅ | ✅ | — |
| 0.84.4 | 662, 1 fail | ✅ | built-in `grok-4.3` map now `minimal: null` (parity test) |
| 0.85.1 | 660, 3 fail | test-only TS7053 | built-in `grok-build-0.1` removed (CHANGELOG 0.85.0, #9093) |
| 0.86.1 | 660, 3 fail | ❌ `responses.ts:257` TS2741 | stream inputs become branded `TranscriptContext` (CHANGELOG 0.86.0 Breaking) |
| 0.87.1 / 0.99.2 / 1.0.0 | 660, 3 fail | ❌ same | nothing new for us |

Every version from 0.84.4 on also trips `compatibility:check` (newer release than policy latest).
