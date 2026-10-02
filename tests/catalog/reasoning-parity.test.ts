import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { describe, expect, it } from "vitest";
import { normalizeXaiCatalogPayload } from "../../extensions/xai/catalog-normalize";
import {
  KNOWN_XAI_MODEL_METADATA,
  type XaiCatalogModel,
} from "../../extensions/xai/models";

/**
 * Reasoning-level parity between Pi's built-in `xai` provider catalog and this
 * package's `xai-auth` catalog (issue #147).
 *
 * The two catalogs stay separate by design: built-in `xai` is Pi's generated
 * API-key catalog, while `xai-auth` derives levels from authenticated
 * `/models-v2` evidence plus bounded known metadata. These tests pin the
 * differences a user can observe when switching providers so drift is a test
 * failure rather than a silent surprise.
 */

const fixture = async (name: string) =>
  JSON.parse(
    await readFile(join(process.cwd(), "tests/fixtures/models-v2", name), "utf8"),
  );

const supportedLevels = (model: XaiCatalogModel) =>
  getSupportedThinkingLevels(model as unknown as Model<Api>);

/**
 * Look up a built-in model by id without assuming it exists on every supported
 * Pi line. `XAI_MODELS` is a literal type whose membership changes across the
 * range (0.80.1 has no `grok-4.5`), so index it through a widened record.
 */
const builtIn = (id: string): Model<Api> | undefined =>
  (XAI_MODELS as unknown as Record<string, Model<Api> | undefined>)[id];

const known = (id: string) => {
  const model = KNOWN_XAI_MODEL_METADATA.find((entry) => entry.id === id);
  if (!model) throw new Error(`missing known metadata for ${id}`);
  return model;
};

describe("built-in xai vs xai-auth reasoning parity", () => {
  it("inventories the built-in Grok models this package advertises or aliases", () => {
    // Built-in catalog membership changes across the supported Pi range: 0.80.1
    // still ships grok-3 / grok-code-fast-1 and has no grok-4.5, while 0.81+
    // drops the legacy entries. Assert the invariants that must hold on every
    // supported boundary rather than one line's exact membership.
    // Pi 0.85.0 removed the API-key-only grok-build-0.1 and 0.87.1 added
    // grok-4.7, so neither is asserted here.
    const ids = Object.keys(XAI_MODELS);
    expect(ids).toContain("grok-4.3");
    // Package-owned entitlement models never appear in Pi's API-key catalog.
    expect(ids).not.toContain("grok-build");
    expect(ids).not.toContain("grok-composer-2.5-fast");
  });

  it("keeps grok-4.3 levels on xAI's effort set across both providers", () => {
    const xaiLevels = ["off", "low", "medium", "high"];
    expect(supportedLevels(known("grok-4.3"))).toEqual(xaiLevels);
    expect(known("grok-4.3").thinkingLevelMap?.minimal).toBeNull();
    // Pi 0.84.4+ ships an explicit built-in grok-4.3 map with the same set.
    // Earlier built-in rows had no map, so Pi's missing-key rule also listed
    // `minimal`, which xAI does not implement for Grok 4.3.
    const builtIn43 = builtIn("grok-4.3")!;
    expect(getSupportedThinkingLevels(builtIn43)).toEqual(
      builtIn43.thinkingLevelMap
        ? xaiLevels
        : ["off", "minimal", "low", "medium", "high"],
    );
  });

  it("documents the intentional grok-4.5 minimal difference", () => {
    // grok-4.5 only exists in the built-in catalog from Pi 0.81 onward; the
    // xai-auth side is asserted unconditionally either way.
    const builtIn45 = builtIn("grok-4.5");
    if (builtIn45) {
      // Built-in `xai` denies `minimal`; `xai-auth` maps Pi's `minimal` onto the
      // xAI wire value `low`, which is the same request xAI receives for `low`.
      expect(getSupportedThinkingLevels(builtIn45)).toEqual([
        "low",
        "medium",
        "high",
      ]);
    }
    expect(supportedLevels(known("grok-4.5"))).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(known("grok-4.5").thinkingLevelMap?.minimal).toBe("low");
    // Neither provider ever offers `off`, `xhigh`, or `max` for Grok 4.5.
    // Assert effective levels rather than the raw map shape: the supported Pi
    // range spells these differently (0.80.1 has no `max` level at all, 0.81
    // leaves built-in `xhigh`/`max` undefined, 0.82 sets them to null) while
    // meaning the same thing.
    const map = known("grok-4.5").thinkingLevelMap as
      | Record<string, string | null | undefined>
      | undefined;
    for (const level of ["off", "xhigh", "max"] as const) {
      if (builtIn45) {
        expect(getSupportedThinkingLevels(builtIn45)).not.toContain(level);
      }
      expect(supportedLevels(known("grok-4.5"))).not.toContain(level);
      expect(map?.[level] ?? null).toBeNull();
    }
  });

  it("documents grok-4.6 known levels including authenticated xhigh", () => {
    // Live `/models-v2` advertises low/medium/high/xhigh for Grok 4.6. xai-auth
    // keeps Pi's `minimal` → xAI `low` mapping used for Grok 4.5.
    expect(supportedLevels(known("grok-4.6"))).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(known("grok-4.6").thinkingLevelMap?.minimal).toBe("low");
    expect(known("grok-4.6").thinkingLevelMap?.xhigh).toBe("xhigh");
    expect(supportedLevels(known("grok-4.6"))).not.toContain("off");
    expect(supportedLevels(known("grok-4.6"))).not.toContain("max");
  });

  it("never advertises the API-key-only built-in grok-build-0.1 through xai-auth", () => {
    // Built-in Pi lists grok-build-0.1 only before 0.85.0; xai-auth must never
    // advertise it on any supported line.
    expect(KNOWN_XAI_MODEL_METADATA.map(({ id }) => id)).not.toContain(
      "grok-build-0.1",
    );
    expect(
      normalizeXaiCatalogPayload({
        data: [
          {
            model: "grok-build-0.1",
            api_backend: "responses",
            context_window: 256_000,
            supports_reasoning_effort: true,
            reasoning_efforts: ["low", "medium", "high"],
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("authenticated reasoning evidence bounds advertised levels", () => {
  it("derives grok-4.5 levels from authenticated efforts, not known metadata", async () => {
    const [grok45] = normalizeXaiCatalogPayload(
      await fixture("reasoning-levels.json"),
    );
    expect(grok45.id).toBe("grok-4.5");
    expect(supportedLevels(grok45)).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("lets authenticated denial override known reasoning metadata", async () => {
    const [, denied] = normalizeXaiCatalogPayload(
      await fixture("reasoning-levels.json"),
    );
    expect(denied.id).toBe("grok-4.3");
    // Known metadata advertises low/medium/high; authenticated denial wins.
    expect(known("grok-4.3").thinkingLevelMap?.high).toBe("high");
    expect(denied.reasoning).toBe(false);
    expect(denied.thinkingLevelMap).toEqual({ off: "none" });
    expect(supportedLevels(denied)).toEqual(["off"]);
  });

  it("hides levels the authenticated catalog does not list", async () => {
    const [, , partial] = normalizeXaiCatalogPayload(
      await fixture("reasoning-levels.json"),
    );
    expect(partial.id).toBe("grok-partial-effort");
    expect(supportedLevels(partial)).toEqual(["low"]);
    expect(partial.thinkingLevelMap).toMatchObject({
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
  });

  it("keeps xhigh and max hidden unless the catalog names them", () => {
    const [bounded] = normalizeXaiCatalogPayload({
      data: [
        {
          model: "grok-4.5",
          api_backend: "responses",
          context_window: 500_000,
          supports_reasoning_effort: true,
          reasoning_efforts: ["low", "medium", "high"],
        },
      ],
    });
    expect(supportedLevels(bounded)).not.toContain("xhigh");
    expect(supportedLevels(bounded)).not.toContain("max");

    const [extended] = normalizeXaiCatalogPayload({
      data: [
        {
          model: "grok-4.5",
          api_backend: "responses",
          context_window: 500_000,
          supports_reasoning_effort: true,
          reasoning_efforts: ["low", "medium", "high", "max"],
        },
      ],
    });
    // xAI's `max` canonicalizes to Pi's `xhigh`; `max` itself stays denied.
    expect(supportedLevels(extended)).toContain("xhigh");
    expect(supportedLevels(extended)).not.toContain("max");
  });

  it("advertises an entitled grok-4.7 with exactly the catalog's efforts", () => {
    // xai-auth keeps no known metadata for Grok 4.7: authenticated /models-v2
    // evidence alone decides its levels, and minimal is not aliased (4.5/4.6 only).
    const [grok47] = normalizeXaiCatalogPayload({
      data: [
        {
          model: "grok-4.7",
          api_backend: "responses",
          context_window: 256_000,
          supports_reasoning_effort: true,
          reasoning_efforts: ["low", "medium", "high", "xhigh"],
        },
      ],
    });
    expect(grok47).toMatchObject({ id: "grok-4.7", apiBackend: "responses", reasoning: true });
    expect(supportedLevels(grok47)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(KNOWN_XAI_MODEL_METADATA.map(({ id }) => id)).not.toContain("grok-4.7");
  });

  it("maps authenticated grok-4.6 efforts including xhigh and minimal→low", () => {
    const [grok46] = normalizeXaiCatalogPayload({
      data: [
        {
          model: "grok-4.6",
          name: "Grok 4.6",
          api_backend: "responses",
          context_window: 500_000,
          supports_reasoning_effort: true,
          reasoning_efforts: [
            { value: "xhigh" },
            { value: "high" },
            { value: "medium" },
            { value: "low" },
          ],
        },
      ],
    });
    expect(grok46.id).toBe("grok-4.6");
    expect(supportedLevels(grok46)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(grok46.thinkingLevelMap?.minimal).toBe("low");
    expect(grok46.thinkingLevelMap?.xhigh).toBe("xhigh");
  });
});
