import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeXaiCatalogPayload,
  XaiCatalogValidationError,
} from "../../extensions/xai/catalog";
import { XaiModelInputProvenance } from "../../extensions/xai/models";

const fixture = async (name: string) =>
  JSON.parse(
    await readFile(
      join(process.cwd(), "tests/fixtures/models-v2", name),
      "utf8",
    ),
  );

describe("catalog normalization", () => {
  it("preserves exact additions and known/unknown metadata", async () => {
    const models = normalizeXaiCatalogPayload(await fixture("additions.json"));
    expect(models.map(({ id }) => id)).toEqual([
      "grok-4.5",
      "grok-composer-2.5-fast",
      "grok-new-oauth-model",
    ]);
    expect(models[0]).toMatchObject({
      contextWindow: 500_000,
      maxTokens: 131_072,
    });
    expect(models[0].thinkingLevelMap).toMatchObject({
      off: null,
      minimal: "low",
    });
    expect(models[2]).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.Default,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(models[2].thinkingLevelMap).toMatchObject({
      medium: "medium",
      xhigh: "xhigh",
    });
  });

  it("enriches Grok 4.7 without adding unrelated models or overriding authenticated limits", () => {
    const entry = { model: "grok-4.7", api_backend: "responses", context_window: 500_000 };
    const models = normalizeXaiCatalogPayload({ data: [entry] });
    expect(models.map(({ id }) => id)).toEqual(["grok-4.7"]);
    expect(models[0]).toMatchObject({
      input: ["text", "image"],
      inputProvenance: XaiModelInputProvenance.Known,
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
      maxTokens: 131_072,
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
    });
    const [restricted] = normalizeXaiCatalogPayload({ data: [{
      ...entry,
      context_window: 100_000,
      max_completion_tokens: 8_192,
      acceptsImages: false,
      supports_reasoning_effort: false,
    }] });
    expect(restricted).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
      contextWindow: 100_000,
      maxTokens: 8_192,
      reasoning: false,
      thinkingLevelMap: { off: "none" },
    });
    expect(normalizeXaiCatalogPayload({ data: [] })).toEqual([]);
  });

  it("keeps Grok 4.7 when its advertised completion limit exceeds its context", async () => {
    // Allowlisted metadata from the observed catalog shape, never a raw response.
    const models = normalizeXaiCatalogPayload(await fixture("grok-4.7-limits.json"));
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "grok-4.7",
      contextWindow: 500_000,
      maxTokens: 500_000,
    });
  });

  it("also clamps independent camelCase limits in metadata for unknown models", () => {
    const [model] = normalizeXaiCatalogPayload({ data: [{
      model: "new-oauth-model",
      _meta: { apiBackend: "responses", contextWindow: 100_000, maxCompletionTokens: 200_000 },
    }] });
    expect(model).toMatchObject({ id: "new-oauth-model", contextWindow: 100_000, maxTokens: 100_000 });
  });

  it.each([0, -1, 1.5, "1000000", null, true, 1_000_001, Infinity, NaN])(
    "still rejects invalid or absolutely oversized completion limits: %j",
    (max_completion_tokens) => {
      expect(() => normalizeXaiCatalogPayload({ data: [{
        model: "grok-4.7", api_backend: "responses", context_window: 500_000, max_completion_tokens,
      }] })).toThrow(XaiCatalogValidationError);
    },
  );

  it("applies authenticated modality precedence without changing membership", async () => {
    const models = normalizeXaiCatalogPayload(await fixture("modalities.json"));
    expect(models.map(({ id }) => id)).toEqual([
      "grok-4.5",
      "grok-composer-2.5-fast",
      "synthetic-modalities",
      "synthetic-meta-accepts",
    ]);
    expect(models.map(({ input, inputProvenance }) => ({ input, inputProvenance }))).toEqual([
      {
        input: ["text"],
        inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
      },
      {
        input: ["text", "image"],
        inputProvenance: XaiModelInputProvenance.Known,
      },
      {
        input: ["text", "image"],
        inputProvenance: XaiModelInputProvenance.AuthenticatedInputModalities,
      },
      {
        input: ["text", "image"],
        inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
      },
    ]);
  });

  it("falls through malformed higher-priority fields to bounded evidence", () => {
    const [entryAccepts, entryModalities, metaModalities] = normalizeXaiCatalogPayload({
      data: [
        {
          model: "entry-accepts",
          api_backend: "responses",
          context_window: 100_000,
          acceptsImages: false,
          _meta: { acceptsImages: true },
          inputModalities: ["text", "image"],
        },
        {
          model: "entry-modalities",
          api_backend: "responses",
          context_window: 100_000,
          acceptsImages: "false",
          inputModalities: ["image", "text"],
          _meta: { acceptsImages: 1 },
        },
        {
          model: "meta-modalities",
          api_backend: "responses",
          context_window: 100_000,
          acceptsImages: null,
          inputModalities: ["audio"],
          _meta: { inputModalities: ["text"] },
        },
      ],
    });
    expect(entryAccepts).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    });
    expect(entryModalities).toMatchObject({
      input: ["text", "image"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedInputModalities,
    });
    expect(metaModalities).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedInputModalities,
    });
  });

  it.each([
    [],
    ["text", "image", "text"],
    ["text", "text"],
    ["text", "audio"],
    ["TEXT", "image"],
    "text",
    true,
    { image: true },
  ])("treats malformed inputModalities %j as missing evidence", (inputModalities) => {
    const [model] = normalizeXaiCatalogPayload({
      data: [
        {
          model: "unknown-modality-shape",
          api_backend: "responses",
          context_window: 100_000,
          inputModalities,
        },
      ],
    });
    expect(model).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.Default,
    });
  });

  it("keeps redacted observed missing fields non-authenticated", async () => {
    const models = normalizeXaiCatalogPayload(await fixture("observed-no-modalities.json"));
    expect(models).toHaveLength(2);
    expect(
      models.every(
        (model) =>
          model.inputProvenance === XaiModelInputProvenance.Default &&
          JSON.stringify(model.input) === JSON.stringify(["text"]),
      ),
    ).toBe(true);
  });

  it("maps none and capability defaults to Pi thinking levels", () => {
    const none = normalizeXaiCatalogPayload({
      data: [
        {
          model: "none-capable",
          api_backend: "responses",
          context_window: 100_000,
          supports_reasoning_effort: true,
          reasoning_efforts: ["none", "low"],
        },
      ],
    })[0];
    expect(none.thinkingLevelMap?.off).toBe("none");
    for (const levels of [undefined, [], "malformed"]) {
      const model = normalizeXaiCatalogPayload({
        data: [
          {
            model: "implicit",
            api_backend: "responses",
            context_window: 100_000,
            supports_reasoning_effort: true,
            ...(levels === undefined ? {} : { reasoning_efforts: levels }),
          },
        ],
      })[0];
      expect(model.thinkingLevelMap).toMatchObject({
        low: "low",
        medium: "medium",
        high: "high",
      });
    }
  });

  it("lets authenticated denial override known reasoning metadata", () => {
    const model = normalizeXaiCatalogPayload({
      data: [
        {
          model: "grok-4.5",
          api_backend: "responses",
          context_window: 500_000,
          supports_reasoning_effort: false,
          reasoning_efforts: ["low", "high"],
        },
      ],
    })[0];
    expect(model.reasoning).toBe(false);
    expect(model.thinkingLevelMap).toEqual({ off: "none" });
  });

  it("clamps known output metadata to the authenticated context", () => {
    expect(
      normalizeXaiCatalogPayload({
        data: [
          {
            model: "grok-4.5",
            api_backend: "responses",
            context_window: 100_000,
          },
        ],
      })[0].maxTokens,
    ).toBe(100_000);
  });

  it("treats removals and an empty success as exact entitlements", async () => {
    expect(
      normalizeXaiCatalogPayload(await fixture("removals.json")).map(
        ({ id }) => id,
      ),
    ).toEqual(["grok-composer-2.5-fast"]);
    expect(normalizeXaiCatalogPayload({ data: [] })).toEqual([]);
  });

  it("filters malformed entries but rejects wholly malformed payloads", async () => {
    expect(
      normalizeXaiCatalogPayload(await fixture("malformed.json")).map(
        ({ id }) => id,
      ),
    ).toEqual(["meta-valid-model"]);
    expect(() =>
      normalizeXaiCatalogPayload({
        data: [{ model: "bad", context_window: 1000 }],
      }),
    ).toThrow(XaiCatalogValidationError);
    expect(() => normalizeXaiCatalogPayload({ models: [] })).toThrow(
      XaiCatalogValidationError,
    );
  });

  it("filters API-key and secret-bearing models before normalization", async () => {
    const models = normalizeXaiCatalogPayload(
      await fixture("api-key-only.json"),
    );
    expect(models.map(({ id }) => id)).toEqual(["oauth-safe-model"]);
    expect(models[0].name).toBe("OAuth Safe Model");
    expect(JSON.stringify(models)).not.toMatch(
      /MUST_NOT_REACH_CACHE|XAI_API_KEY/,
    );
  });
});
