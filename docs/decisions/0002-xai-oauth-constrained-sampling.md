<!-- markdownlint-disable MD013 -->

# ADR 0002: Defer constrained sampling for xAI OAuth custom tools

- **Status:** Accepted — no runtime change
- **Date:** 2026-07-25
- **Issue:** [#146](https://github.com/BlockedPath/pi-xai-oauth/issues/146)
- **Pi range reviewed:** `>=0.80.1 <0.83.0` (exact boundaries 0.80.1 and 0.82.1)

## Decision

Do not add `Tool.constrainedSampling`, `compat.supportsStrictMode`, or grammar-tool capability metadata to this package in this slice.

Pi 0.82's `{ type: "json_schema", strict: "prefer" }` is a safe fallback mechanism only after a provider/model capability decision exists: the OpenAI Responses adapter emits `strict: true` when `model.compat.supportsStrictMode` is true and otherwise sends an ordinary function tool without a `strict` field. The package-owned `xai-auth` catalog has no verified strict-mode metadata, and Pi 0.80.1 does not expose `Tool.constrainedSampling` at all.

The public xAI documentation is positive evidence for xAI's public model surfaces, but it is not sufficient evidence for the separately pinned OAuth session route at `https://cli-chat-proxy.grok.com/v1/responses`. The bounded live probe described below could not reach schema validation. Advertising the capability for the OAuth catalog would therefore turn an unverified route assumption into runtime metadata. That conflicts with this package's evidence policy.

No custom tool is selected for a pilot until the OAuth route is verified. Existing JSON schemas and local validation remain unchanged. In particular, this decision does not add `strict: "require"`, grammar mode, or an inferred catalog field.

## Evidence

### First-party xAI documentation

On 2026-07-25, the following first-party pages were reviewed:

- [Function Calling](https://docs.x.ai/developers/tools/function-calling) documents JSON Schema function parameters and states that the root must be an object (or a union whose branches are objects). It also documents schema shapes rejected with HTTP 400.
- [Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) states that xAI model tool-call arguments strictly conform to their input JSON Schema and that strict behavior is implicit. It also limits guarantees to xAI's supported JSON Schema subset and recommends local validation for best-effort keywords and limits.

These pages describe xAI model/API behavior generally and show public SDK/API examples. They do not identify the authenticated Grok CLI proxy as a covered endpoint, do not document the OAuth proxy's compatibility contract, and do not provide a proxy-specific strict-tool fixture.

### Bounded OAuth Responses probe

A local one-shot probe used an existing OAuth credential only in the protected `Authorization` header and sent requests solely to the repository's pinned CLI Responses URL. It did not print or persist the credential, authenticated headers, request IDs, raw response bodies, or error text.

The probe compared:

1. a valid closed object tool with no `strict` member;
2. the same tool with `strict: true`;
3. the same tool with `strict: false`;
4. `strict: true` with an open object schema;
5. an invalid scalar-root tool schema that first-party documentation says should fail schema compilation;
6. a request with no tools; and
7. an invalid model control.

Every variant returned the same HTTP 402 outcome with no output items. Because even the invalid schema and invalid model controls reached the same gate, the response occurred before the probe could distinguish tool-schema acceptance, rejection, enforcement, or fallback. HTTP status alone is retained here; raw authenticated bodies were not logged.

This is evidence that the available account could not perform a valid capability probe, not evidence that the proxy supports or rejects strict tools.

### Pi 0.82 transport behavior

Pi 0.82.1's official constrained-sampling documentation defines `strict: "prefer"` as strict enforcement when supported and ordinary tool calling otherwise. Its OpenAI Responses implementation resolves JSON-schema constrained sampling from `model.compat.supportsStrictMode`; for that adapter the compatibility default is false. With no verified capability metadata, `strict: "prefer"` produces an ordinary function tool and omits the wire-level `strict` field. `strict: "require"` would reject locally instead, which is why it is explicitly out of scope.

The authoritative Pi references reviewed were:

- [Pi 0.82 constrained-sampling documentation](https://github.com/earendil-works/pi/blob/v0.82.0/packages/ai/README.md#constrained-sampling-for-tools)
- [`resolveJsonSchemaStrictSampling` at Pi 0.82.1](https://github.com/earendil-works/pi/blob/v0.82.1/packages/ai/src/api/constrained-sampling.ts)
- [OpenAI Responses tool conversion at Pi 0.82.1](https://github.com/earendil-works/pi/blob/v0.82.1/packages/ai/src/api/openai-responses-shared.ts)

## Rejected alternatives

| Alternative | Reason rejected |
| --- | --- |
| Add `{ type: "json_schema", strict: "prefer" }` to one tool without capability metadata | It would always take Pi's ordinary-function fallback for current `xai-auth` models, so it would not establish the requested supported pilot. It would also introduce a Pi 0.82-only field that must be hidden from the 0.80.1 type surface for no demonstrated runtime benefit. |
| Set `compat.supportsStrictMode: true` on package models | The public xAI claim has not been verified for the pinned OAuth proxy. This would invent package catalog compatibility metadata. |
| Treat HTTP 402 parity as schema acceptance | The invalid-schema and invalid-model controls also returned 402, showing only that an earlier entitlement gate won. |
| Use `strict: "require"` | The issue excludes it, and it would fail requests rather than preserve fallback. |
| Use grammar constrained sampling | No first-party evidence supports grammar tools on this route, and the issue explicitly excludes grammar mode. |

## Revisit criteria

A future pilot may proceed when at least one of the following is available:

1. first-party documentation explicitly covering strict function-tool schemas on the pinned OAuth CLI Responses route; or
2. a bounded live probe on that route which reaches inference and demonstrates a valid closed schema with `strict: true`, plus controls that distinguish schema validation from earlier auth, entitlement, model, and version gates.

Any future pilot should use one simple, closed object schema; retain Pi/local argument validation and `prepareArguments`; use only `strict: "prefer"`; test both `supportsStrictMode: true` and false payloads; and preserve the Pi 0.80.1 typecheck through a compatibility-safe representation. Grammar support requires separate first-party evidence and review.
