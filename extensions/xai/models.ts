import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_XAI_MODEL, XAI_PROVIDER_ID } from "./constants";
import { resolveXaiRoute, type XaiCredentialKind } from "./routing";
export {
  resolveXaiClientMode,
  xaiProxyRequestHeaders,
  type XaiClientMode,
  type XaiProxyRequestMetadata,
} from "./wire";

/** Bounded evidence used to derive one normalized model input capability. */
export enum XaiModelInputProvenance {
  AuthenticatedAcceptsImages = "authenticated-accepts-images",
  AuthenticatedInputModalities = "authenticated-input-modalities",
  Known = "known-model-metadata",
  Default = "conservative-default",
}

export type XaiCatalogModel = {
  id: string;
  name: string;
  apiBackend: "responses";
  reasoning: boolean;
  input: ("text" | "image")[];
  inputProvenance: XaiModelInputProvenance;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
};

/**
 * Curated metadata for known xAI models.
 *
 * This table enriches models that the authenticated catalog actually returns
 * (and their known aliases after entitlement expansion). It is not the provider
 * advertisement and must never be unioned wholesale into a successful entitlement
 * response.
 */
export const KNOWN_XAI_MODEL_METADATA: readonly XaiCatalogModel[] = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    apiBackend: "responses",
    reasoning: true,
    input: ["text", "image"],
    inputProvenance: XaiModelInputProvenance.Known,
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    // xAI has not published a Grok 4.5-specific max output limit yet;
    // keep the existing Grok Responses ceiling until official metadata is available.
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      // `max` is intentionally omitted rather than spelled out as null: Pi
      // 0.80.1's ModelThinkingLevel has no `max` member, and Pi treats an
      // absent key and an explicit null identically. Advertised levels are the
      // same either way.
    },
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    apiBackend: "responses",
    reasoning: true,
    input: ["text", "image"],
    inputProvenance: XaiModelInputProvenance.Known,
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "grok-build",
    name: "Grok Build",
    apiBackend: "responses",
    reasoning: true,
    input: ["text", "image"],
    inputProvenance: XaiModelInputProvenance.Known,
    cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.2 },
    contextWindow: 512_000,
    maxTokens: 30_000,
  },
  {
    id: "grok-composer-2.5-fast",
    name: "Composer 2.5 Fast",
    apiBackend: "responses",
    reasoning: false,
    input: ["text", "image"],
    inputProvenance: XaiModelInputProvenance.Known,
    cost: { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 Reasoning",
    apiBackend: "responses",
    reasoning: true,
    input: ["text", "image"],
    inputProvenance: XaiModelInputProvenance.Known,
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 Non-Reasoning",
    apiBackend: "responses",
    reasoning: false,
    input: ["text", "image"],
    inputProvenance: XaiModelInputProvenance.Known,
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    apiBackend: "responses",
    reasoning: true,
    input: ["text", "image"],
    inputProvenance: XaiModelInputProvenance.Known,
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
];

const KNOWN_MODEL_MAP = new Map(KNOWN_XAI_MODEL_METADATA.map((model) => [model.id, model]));

/**
 * Known OAuth model aliases mapped to the canonical catalog id they currently
 * resolve to on xAI's session Responses proxy / public model registry.
 *
 * Only aliases of models that are already entitled are advertised. This keeps
 * the authenticated catalog exact while preserving renamed settings patterns
 * such as `grok-composer-2.5-fast` when the account only receives `grok-4.5`.
 *
 * Source evidence: official Grok catalog key/slug split, `api.x.ai/v1/models`
 * alias lists, and OAuth Responses resolution (e.g. Composer → `grok-4.5-build`).
 */
export const XAI_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Grok 4.5 family absorbs former Build-latest / Composer routing.
  "grok-4.5-latest": "grok-4.5",
  "grok-build-latest": "grok-4.5",
  "grok-composer-2.5-fast": "grok-4.5",

  // Grok 4.3 short names.
  "grok-4.3-latest": "grok-4.3",
  "grok-latest": "grok-4.3",

  // Grok 4.20 short / beta aliases → dated canonicals.
  "grok-4.20": "grok-4.20-0309-reasoning",
  "grok-4.20-0309": "grok-4.20-0309-reasoning",
  "grok-4.20-reasoning": "grok-4.20-0309-reasoning",
  "grok-4.20-reasoning-latest": "grok-4.20-0309-reasoning",
  "grok-4.20-non-reasoning": "grok-4.20-0309-non-reasoning",
  "grok-4.20-non-reasoning-latest": "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent": "grok-4.20-multi-agent-0309",
  "grok-4.20-multi-agent-latest": "grok-4.20-multi-agent-0309",
};

/**
 * Additional model slugs proven usable through the OAuth Responses proxy even
 * when `/models-v2` advertises only the model that grants the route entitlement.
 *
 * Keep this separate from `XAI_MODEL_ALIASES`: these slugs remain distinct
 * request models and must not canonicalize to their entitlement source.
 *
 * Evidence (2026-07-18): the same session catalog contained only `grok-4.5`,
 * while a bounded `grok-4.3` Responses probe completed successfully and reported
 * `grok-4.3` as the response model.
 */
export const XAI_MODEL_ENTITLEMENT_COMPATIBILITY: Readonly<Record<string, string>> = {
  "grok-4.3": "grok-4.5",
};

const XAI_ADVERTISEMENTS_BY_ENTITLEMENT = (() => {
  const map = new Map<string, string[]>();
  const advertisements = [
    ...Object.entries(XAI_MODEL_ALIASES),
    ...Object.entries(XAI_MODEL_ENTITLEMENT_COMPATIBILITY),
  ];
  for (const [advertised, entitlementSource] of advertisements) {
    const key = entitlementSource.toLowerCase();
    const list = map.get(key);
    if (list) list.push(advertised);
    else map.set(key, [advertised]);
  }
  for (const list of map.values()) list.sort();
  return map;
})();

/** Minimal catalog used only when authenticated discovery cannot be used safely. */
export const CURATED_FALLBACK_MODELS: readonly XaiCatalogModel[] = [
  { ...KNOWN_MODEL_MAP.get(DEFAULT_XAI_MODEL)! },
];

/** Backward-compatible alias for the curated offline fallback. */
export const MODELS = CURATED_FALLBACK_MODELS;

let runtimeModels: readonly XaiCatalogModel[] = CURATED_FALLBACK_MODELS;

/** Replace request-helper metadata with the current entitlement snapshot. */
export function setXaiRuntimeModels(models: readonly XaiCatalogModel[]): void {
  runtimeModels = models.map((model) => ({
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
  }));
}

/** Return the current entitlement snapshot used by direct request helpers. */
export function getXaiRuntimeModels(): readonly XaiCatalogModel[] {
  return runtimeModels;
}

/** Return true only when the active OAuth catalog currently advertises a model. */
export function isXaiRuntimeModelEntitled(modelId: string): boolean {
  return getXaiRuntimeModel(modelId) !== undefined;
}

/** Return one model from the current entitlement snapshot without falling back. */
export function getXaiRuntimeModel(modelId: string): XaiCatalogModel | undefined {
  const normalized = normalizedXaiModelId(modelId);
  return runtimeModels.find((model) => model.id.toLowerCase() === normalized);
}

/** Return whether a provenance value came from bounded authenticated catalog evidence. */
export function isAuthenticatedXaiInputProvenance(
  provenance: XaiModelInputProvenance,
): boolean {
  return provenance === XaiModelInputProvenance.AuthenticatedAcceptsImages ||
    provenance === XaiModelInputProvenance.AuthenticatedInputModalities;
}

/** Return whether authenticated catalog evidence explicitly marks a model text-only. */
export function isExplicitAuthenticatedTextOnlyXaiModel(model: XaiCatalogModel): boolean {
  return isAuthenticatedXaiInputProvenance(model.inputProvenance)
    && model.input.includes("text")
    && !model.input.includes("image");
}

/** Return whether authenticated catalog evidence explicitly permits text and image input. */
export function isExplicitAuthenticatedVisionXaiModel(model: XaiCatalogModel): boolean {
  return isAuthenticatedXaiInputProvenance(model.inputProvenance)
    && model.input.includes("text")
    && model.input.includes("image");
}

/** Choose the default model from the active OAuth catalog, if one exists. */
export function defaultXaiRuntimeModelId(): string | undefined {
  return runtimeModels.find((model) => model.id === DEFAULT_XAI_MODEL)?.id ?? runtimeModels[0]?.id;
}

/** Return curated metadata for a known model without advertising it. */
export function knownXaiModelMetadata(modelId: string): XaiCatalogModel | undefined {
  return KNOWN_MODEL_MAP.get(normalizedXaiModelId(modelId));
}

/**
 * Resolve a model id through the known alias table to its canonical catalog id.
 * Unknown ids are returned normalized without inventing an entitlement.
 */
export function resolveXaiCanonicalModelId(modelId: string): string {
  const normalized = normalizedXaiModelId(modelId);
  if (!normalized) return normalized;
  return XAI_MODEL_ALIASES[normalized] ?? normalized;
}

/**
 * Expand an exact entitlement snapshot with known aliases and proven compatible
 * OAuth request models. The remote/cache catalog stays exact; only the advertised
 * runtime provider list gains compatibility entries.
 */
export function expandXaiCatalogWithAliases(
  models: readonly XaiCatalogModel[],
): XaiCatalogModel[] {
  const entitled = new Map<string, XaiCatalogModel>();
  for (const model of models) {
    entitled.set(model.id.toLowerCase(), {
      ...model,
      input: [...model.input],
      cost: { ...model.cost },
      ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    });
  }

  const expanded: XaiCatalogModel[] = [...entitled.values()];
  const aliasEntries: Array<[string, XaiCatalogModel]> = [];
  for (const [canonical, base] of entitled) {
    const aliases = XAI_ADVERTISEMENTS_BY_ENTITLEMENT.get(canonical) ?? [];
    for (const alias of aliases) {
      if (entitled.has(alias)) continue;
      aliasEntries.push([alias, materializeAliasModel(alias, base)]);
    }
  }
  aliasEntries.sort(([left], [right]) => left.localeCompare(right));
  for (const [, model] of aliasEntries) expanded.push(model);
  return expanded;
}

function materializeAliasModel(alias: string, base: XaiCatalogModel): XaiCatalogModel {
  const known = knownXaiModelMetadata(alias);
  const maxTokens = Math.min(known?.maxTokens ?? base.maxTokens, base.contextWindow);
  return {
    id: alias,
    name: known?.name ?? base.name,
    apiBackend: "responses",
    reasoning: known?.reasoning ?? base.reasoning,
    // Preserve authenticated modality evidence from the entitled canonical.
    input: [...base.input],
    inputProvenance: base.inputProvenance,
    cost: known ? { ...known.cost } : { ...base.cost },
    contextWindow: base.contextWindow,
    maxTokens,
    ...(known?.thinkingLevelMap
      ? { thinkingLevelMap: { ...known.thinkingLevelMap } }
      : base.thinkingLevelMap
        ? { thinkingLevelMap: { ...base.thinkingLevelMap } }
        : {}),
  };
}

/** Build a pi model object for a credential-aware direct xAI request. */
export function xaiModelForRequest(modelId: string | undefined, credentialKind: XaiCredentialKind): Model<Api> {
  const id = modelId || DEFAULT_XAI_MODEL;
  const model =
    runtimeModels.find((candidate) => candidate.id === id) ||
    knownXaiModelMetadata(id) ||
    runtimeModels.find((candidate) => candidate.id === DEFAULT_XAI_MODEL) ||
    CURATED_FALLBACK_MODELS[0];
  return {
    ...model,
    id,
    provider: XAI_PROVIDER_ID,
    api: "xai-responses",
    baseUrl: resolveXaiRoute(credentialKind, "responses").baseUrl,
  } as any;
}

/** Normalize provider/model-prefixed xAI model ids for capability comparisons. */
export function normalizedXaiModelId(modelId: string): string {
  return (modelId || "").toLowerCase().split("/").pop() || "";
}

/**
 * Return true when a model should use Grok CLI Responses payload quirks
 * (strip mid-stream system/reasoning replay).
 *
 * Filesystem tools now use Grok-native names for every xai-auth model.
 * This flag only gates payload rewriting for the legacy entitled `grok-build`
 * catalog entry.
 */
export function isGrokCliCompatibilityModel(modelId: string): boolean {
  return normalizedXaiModelId(modelId) === "grok-build";
}

/** Return true when xAI accepts an explicit Responses reasoning effort. */
export function grokSupportsReasoningEffort(modelId: string): boolean {
  const normalized = normalizedXaiModelId(modelId);
  const runtime = runtimeModels.find((model) => model.id.toLowerCase() === normalized);
  if (runtime?.thinkingLevelMap) {
    return ["minimal", "low", "medium", "high", "xhigh", "max"].some(
      (level) => typeof (runtime.thinkingLevelMap as Record<string, unknown>)[level] === "string",
    );
  }
  return (
    normalized.startsWith("grok-3-mini") ||
    normalized.startsWith("grok-4.20-multi-agent") ||
    normalized.startsWith("grok-4.3") ||
    normalized.startsWith("grok-4.5")
  );
}
