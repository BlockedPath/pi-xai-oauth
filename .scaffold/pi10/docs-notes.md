# Pi 1.0 notes (Claude), from the bundled 1.0.0 docs/CHANGELOG and the user-supplied links

User-supplied links: https://earendil.com/posts/pi-1-0/ · https://earendil.com/posts/pi-durable/ · https://pi.dev/docs/latest
(The bundled `pi-coding-agent/docs/*.md` in the 1.0.0 reference install are the exact-version source of truth.)

- **0.86.0 Breaking:** provider stream inputs are a normalized `TranscriptContext` (`{ messages }`, with the prompt and tools in a
  leading system message). Only `normalizeContext()` produces it. The brand is type-only (`declare const`).
  The top-level `streamSimple` normalizes before dispatching to any provider (`pi-ai/dist/compat.js:186-196`), so our provider
  already receives a transcript at runtime. Direct callers passing a raw `Context` (our tests) lose `systemPrompt` and `tools`,
  because `normalizeContext` returns `{ messages }` only and the delegate reads messages only.
  `normalizeContext` is idempotent on a transcript.
- **Mid-conversation system messages (1.0):** the Responses delegate calls `resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages ?? false)`
  (`openai-responses.js:65,95`), so it collapses them unless the model opts in. Our models do not opt in, so xAI keeps receiving
  one leading system message, and our rewrite moves it into `instructions` as before. No change is needed. Opting in is a separate, future decision.
- **custom-provider.md:** reusing a supported streaming API is the recommended path (ours). Custom streams must honour `onPayload`,
  `onResponse`, `onProviderStreamEvent` and abort. We spread `options` into the delegate, so these pass through; `onPayload` is wrapped.
- **0.87.0 Breaking:** `shouldStopAfterTurn` removed; `context` handlers no longer see system messages; new `context_with_system`.
  We use none of these. Our events are `session_start`, `input`, `model_select`, `before_agent_start` (returns tool sync, not
  `systemPrompt`), `turn_end` and `session_shutdown`.
- **Built-in xAI catalog:** 0.84.3 moves built-in xAI to the Responses API with encrypted replay (Grok 4.6 default); 0.84.4 gives `grok-4.3` an explicit map
  without `minimal`; 0.85.0 removes `grok-build-0.1`; 0.87.1 adds `grok-4.7` as the default with `xhigh`; `grok-4.6` gains `xhigh`.
- `getSupportedThinkingLevels` is byte-identical in 0.84.2 and 1.0.0 (missing key = supported, except xhigh/max, which need an explicit
  mapping; `null` = unsupported). Our `grok-4.3` has always offered `minimal` (→ xAI `low`); the parity diff comes purely from upstream data.
- **0.99.0:** tool exposure modes, image `ModelRuntime`, and extension model lists that may carry chat/image/classifier entries. Not needed for parity.
- **Pi Durable** is an experimental separate package (`@earendil-works/pi-durable`; tool `replay` safety, durable tasks). Out of scope.
