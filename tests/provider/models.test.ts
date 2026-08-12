import { afterEach, describe, expect, it } from "vitest";
import {
  CURATED_FALLBACK_MODELS,
  expandXaiCatalogWithAliases,
  getXaiRuntimeModels,
  grokSupportsReasoningEffort,
  isGrokCliCompatibilityModel,
  isXaiRuntimeModelEntitled,
  knownXaiModelMetadata,
  normalizedXaiModelId,
  resolveXaiCanonicalModelId,
  resolveXaiClientMode,
  setXaiRuntimeModels,
  XaiModelInputProvenance,
  xaiProxyRequestHeaders,
} from "../../extensions/xai/models";
import { xaiCatalogHeaders } from "../../extensions/xai/wire";

afterEach(() => setXaiRuntimeModels(CURATED_FALLBACK_MODELS));
describe("model compatibility metadata", () => {
  it("normalizes IDs and detects Grok CLI compatibility models", () => {
    expect(normalizedXaiModelId("xai-auth/GROK-BUILD")).toBe("grok-build");
    expect(isGrokCliCompatibilityModel("grok-build")).toBe(true);
    // Composer follows the 4.5 payload path; tool naming is now model-independent.
    expect(isGrokCliCompatibilityModel("grok-composer-2.5-fast")).toBe(false);
    expect(isGrokCliCompatibilityModel("grok-4.5")).toBe(false);
  });

  it("resolves known renamed model aliases to canonical catalog ids", () => {
    expect(resolveXaiCanonicalModelId("xai-auth/grok-composer-2.5-fast")).toBe("grok-4.5");
    expect(resolveXaiCanonicalModelId("grok-build-latest")).toBe("grok-4.5");
    // Grok 4.3 is a distinct OAuth request model, not a canonical alias of 4.5.
    expect(resolveXaiCanonicalModelId("grok-4.3")).toBe("grok-4.3");
    expect(resolveXaiCanonicalModelId("grok-4.20")).toBe("grok-4.20-0309-reasoning");
    expect(resolveXaiCanonicalModelId("grok-4.20-multi-agent")).toBe("grok-4.20-multi-agent-0309");
    expect(resolveXaiCanonicalModelId("grok-4.5")).toBe("grok-4.5");
    expect(resolveXaiCanonicalModelId("grok-4.6")).toBe("grok-4.6");
    expect(resolveXaiCanonicalModelId("unknown-model")).toBe("unknown-model");
  });

  it("curates Grok 4.6 as the offline default with xhigh reasoning metadata", () => {
    const known = knownXaiModelMetadata("grok-4.6");
    expect(known).toMatchObject({
      id: "grok-4.6",
      name: "Grok 4.6",
      apiBackend: "responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 500_000,
      maxTokens: 131_072,
    });
    expect(known?.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    expect(CURATED_FALLBACK_MODELS.map(({ id }) => id)).toEqual(["grok-4.6"]);
    expect(grokSupportsReasoningEffort("grok-4.6")).toBe(true);
    expect(grokSupportsReasoningEffort("xai-auth/GROK-4.6")).toBe(true);
  });

  it("expands only aliases of entitled models and preserves authenticated input", () => {
    const entitled = {
      ...CURATED_FALLBACK_MODELS[0],
      id: "grok-4.5",
      input: ["text"] as ("text" | "image")[],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    };
    const expanded = expandXaiCatalogWithAliases([entitled]);
    const ids = expanded.map((model) => model.id);

    expect(ids).toContain("grok-4.5");
    expect(ids).toContain("grok-4.3");
    expect(ids).toContain("grok-composer-2.5-fast");
    expect(ids).toContain("grok-build-latest");
    expect(ids).toContain("grok-4.5-latest");
    // Compatibility expansion is intentionally not recursive: unproven 4.3 aliases
    // and unrelated model families stay hidden.
    expect(ids).not.toContain("grok-latest");
    expect(ids).not.toContain("grok-4.20-0309-reasoning");
    expect(ids).not.toContain("grok-4.20");
    expect(ids).not.toContain("grok-build");

    const composer = expanded.find((model) => model.id === "grok-composer-2.5-fast");
    expect(composer).toMatchObject({
      name: knownXaiModelMetadata("grok-composer-2.5-fast")?.name,
      reasoning: false,
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
      contextWindow: entitled.contextWindow,
    });

    const fourThree = expanded.find((model) => model.id === "grok-4.3");
    expect(fourThree).toMatchObject({
      name: "Grok 4.3",
      reasoning: true,
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
      // Keep the authenticated entitlement source's conservative context bound.
      contextWindow: entitled.contextWindow,
      thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high" },
    });

    setXaiRuntimeModels(expanded);
    expect(isXaiRuntimeModelEntitled("grok-composer-2.5-fast")).toBe(true);
    expect(isXaiRuntimeModelEntitled("grok-4.3")).toBe(true);
    expect(isXaiRuntimeModelEntitled("grok-4.20")).toBe(false);
  });

  it("does not invent aliases when the canonical model is absent", () => {
    const onlyFourThree = expandXaiCatalogWithAliases([
      {
        ...CURATED_FALLBACK_MODELS[0],
        id: "grok-4.3",
        name: "Grok 4.3",
      },
    ]);
    const ids = onlyFourThree.map((model) => model.id);
    expect(ids).toContain("grok-4.3");
    expect(ids).toContain("grok-latest");
    expect(ids).not.toContain("grok-composer-2.5-fast");
    expect(ids).not.toContain("grok-4.5");
  });
  it("looks up runtime reasoning case-insensitively", () => {
    setXaiRuntimeModels([
      {
        ...CURATED_FALLBACK_MODELS[0],
        id: "Mixed-Case",
        thinkingLevelMap: { low: "low" },
      },
    ]);
    expect(grokSupportsReasoningEffort("mixed-case")).toBe(true);
    expect(getXaiRuntimeModels()[0].id).toBe("Mixed-Case");
  });
  it.each([
    ["TTY default", [], true, true, "interactive"],
    ["model option", ["--model", "grok-4.5"], true, true, "interactive"],
    ["text mode", ["--mode", "text"], true, true, "interactive"],
    ["short print", ["-p", "hello"], true, true, "headless"],
    ["long print", ["--print", "hello"], true, true, "headless"],
    ["JSON mode", ["--mode", "json"], true, true, "headless"],
    ["RPC mode", ["--mode", "rpc"], true, true, "headless"],
    ["non-TTY stdin", [], false, true, "headless"],
    ["non-TTY stdout", [], true, false, "headless"],
    [
      "text mode without stdin TTY",
      ["--mode", "text"],
      false,
      true,
      "headless",
    ],
    ["equals-form mode ignored", ["--mode=json"], true, true, "interactive"],
    ["missing mode value", ["--mode", "--print"], true, true, "interactive"],
  ] as const)("resolves %s", (_label, argv, stdin, stdout, expected) => {
    expect(resolveXaiClientMode(argv, stdin, stdout)).toBe(expected);
  });
  it("omits proxy metadata for API keys and includes protected OAuth metadata", () => {
    expect(
      xaiProxyRequestHeaders("grok-4.5", "api-key", {
        conversationId: "c",
        requestId: "r",
        sessionId: "s",
      }),
    ).toEqual({});
    expect(
      xaiProxyRequestHeaders("grok-4.5", "oauth-session", {
        conversationId: "c",
        requestId: "r",
        sessionId: "s",
      }),
    ).toMatchObject({
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-conv-id": "c",
      "x-grok-req-id": "r",
      "x-grok-model-override": "grok-4.5",
      "x-grok-session-id": "s",
    });
  });
  it.each(["interactive", "headless"] as const)(
    "keeps %s mode consistent across Responses and catalog contracts",
    (clientMode) => {
      const responses = xaiProxyRequestHeaders(
        "grok-4.5",
        "oauth-session",
        { conversationId: "c", requestId: "r", sessionId: "s" },
        { clientMode, streaming: true },
      );
      const catalog = xaiCatalogHeaders("token", clientMode);
      expect(responses["x-grok-client-mode"]).toBe(clientMode);
      expect(catalog["x-grok-client-mode"]).toBe(clientMode);
      expect(responses.Accept).toBe("text/event-stream");
      expect(catalog.Accept).toBe("application/json");
    },
  );
});
