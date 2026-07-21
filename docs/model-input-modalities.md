# Authenticated model input modalities

This package keeps authenticated `/models-v2` membership exact and enriches only the models in that response. Input capability metadata never adds a static model to an account's entitlement set.

## Observed authenticated schema

On 2026-07-16, a bounded authenticated request returned two model entries. The response was inspected through a redacting schema probe: neither entry contained `acceptsImages` or `inputModalities`, either at the entry root or inside `_meta`. The probe retained no bearer, headers, raw response body, endpoint fields, identity fields, or account-specific model IDs. [`tests/fixtures/models-v2/observed-no-modalities.json`](../tests/fixtures/models-v2/observed-no-modalities.json) records only a synthetic redacted version of the non-sensitive shape.

That observation proves only that the fields were absent for that response at that time. It does not prove that a model is text-only, and it does not predict future server population.

## Source basis

The capability names and interpretation come from xAI's Grok Build source at revision [`b189869b7755d2b482969acf6c92da3ecfeffd36`](https://github.com/xai-org/grok-build/tree/b189869b7755d2b482969acf6c92da3ecfeffd36):

- [`model_state.rs`](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-pager/src/acp/model_state.rs#L91-L121) checks `acceptsImages` before `inputModalities` and explicitly says server-side population is separate.
- [Capability tests](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-pager/src/acp/model_state.rs#L628-L649) cover boolean and `text` / `image` array forms.
- [The `/models-v2` parser](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-shell/src/remote/client.rs#L789-L855) does not establish that the server currently supplies either capability.
- [The checked-in fallback catalog](https://github.com/xai-org/grok-build/blob/b189869b7755d2b482969acf6c92da3ecfeffd36/crates/codegen/xai-grok-models/default_models.json) contains only `grok-build`; it is not evidence that Composer is text-only.

## Normalization policy

Only the exact camelCase keys are read. A valid higher-priority value wins in this order:

1. entry `acceptsImages`
2. `_meta.acceptsImages`
3. entry `inputModalities`
4. `_meta.inputModalities`
5. curated known-model metadata
6. conservative `text` input for an unknown model

`acceptsImages` must be a literal boolean. `true` normalizes to `text` plus `image`; `false` normalizes to `text`.

`inputModalities` must be a nonempty array of at most two unique exact values from `text` and `image`. Values are stored in canonical `text`, then `image` order. Empty, duplicate, oversized, unknown, case-variant, coercible, or wrong-type values are ignored as malformed evidence, allowing the next source in the precedence list to apply.

Authenticated evidence overrides known metadata. Missing or malformed evidence does not become authenticated denial: known models retain their curated capability, while unknown models use the conservative text default. In particular, missing fields do not make `grok-composer-2.5-fast` text-only.

The normalized cache records only the final input array and one bounded provenance label. Cache schema 2 preserves whether the result came from authenticated `acceptsImages`, authenticated `inputModalities`, known metadata, or the conservative default. Schema-1 caches are migrated in memory: exact model membership and non-input metadata are retained, but input is rederived as known/default and never promoted to authenticated evidence. A later successful normal atomic catalog write emits schema 2; cancellation restores the exact prior schema-1 file instead of upgrading it.

## Transport enforcement

Before every OAuth Responses network request, the package re-reads the current runtime entitlement snapshot and inspects the final normalized request input. If authenticated evidence explicitly marks that model text-only and the final payload still contains image input, the request fails locally without exposing the image location or data.

For provider streaming, this check runs after package rewriting and after the caller's payload hook, so a hook cannot reintroduce an image immediately before transport. The same direct Responses helper enforces `xai_generate_text(image_url)` and `xai_analyze_image`. The separate `xai_generate_image` Images request creates an image rather than supplying image input to the active Responses model, so it is intentionally unaffected.

## Explicit vision-routing exception

A user can opt in with `/xai-tools enable vision-routing` only when the active source is an **exact** current authenticated catalog member with authenticated text-only evidence and the same exact snapshot contains a different model with authenticated text-and-image evidence. Known/default provenance, missing or malformed fields, names, aliases, and compatibility expansions do not qualify. Eligible targets are selected deterministically by normalized exact model ID.

While authorization is enabled, the streaming transport temporarily advertises `image` only on the delegated Responses conversion-model copy so Pi does not replace current conversation images with placeholders before routing can inspect them. The source's registered catalog metadata remains truthfully text-only, including during package rewriting and caller payload hooks.

Each request is bound to the exact authorization grant captured when streaming starts. A later enable cannot be adopted, and reset or re-enable invalidates the captured grant. User images and computer screenshots preceding a later terminal assistant message are replaced with bounded historical-image placeholders instead of being routed again; `reasoning` and `function_call` items, plus progress messages in the same assistant segment as function calls regardless of content order, do not count because vision descriptions are request-ephemeral and must survive mid tool-loop turns. This consumed-history rewrite runs both before and after the caller payload hook.

Routing makes one bounded additional authenticated Responses request to the target. This image-only conversion request contains only a fixed package instruction and the current unconsumed image inputs; it sends no conversation history, tools, or encrypted-reasoning replay. The returned bounded text is labeled as an xAI-generated visual description, inserted into the source request, and every recognized image or screenshot structure is removed. The final text-only source assertion still runs last, so a surviving image fails locally rather than reaching the source.

Authorization is in-memory, disabled by default, and bound to the current source and exact catalog revision. New sessions, every model/provider change, login/account replacement, catalog replacement, and shutdown clear it. Cancellation or revision invalidation prevents the remaining source request. The package adds no global raw-image or description cache, but the generated description becomes potentially sensitive session content. The separate target request may consume additional allowance, credits, and rate limits.
