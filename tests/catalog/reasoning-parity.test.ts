import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { describe, expect, it } from "vitest";
import { normalizeXaiCatalogPayload } from "../../extensions/xai/catalog";
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

const known = (id: string) => {
  const model = KNOWN_XAI_MODEL_METADATA.find((entry) => entry.id === id);
  if (!model) throw new Error(`missing known metadata for ${id}`);
  return model;
};

describe("built-in xai vs xai-auth reasoning parity", () => {
  it("inventories the built-in Grok models this package advertises or aliases", () => {
    expect(Object.keys(XAI_MODELS).sort()).toEqual([
      "grok-4.3",
      "grok-4.5",
      "grok-build-0.1",
    ]);
  });

  it("keeps grok-4.3 levels identical across both providers", () => {
    expect(supportedLevels(known("grok-4.3"))).toEqual(
      getSupportedThinkingLevels(XAI_MODELS["grok-4.3"]),
    );
  });

  it("documents the intentional grok-4.5 minimal difference", () => {
    // Built-in `xai` denies `minimal`; `xai-auth` maps Pi's `minimal` onto the
    // xAI wire value `low`, which is the same request xAI receives for `low`.
    expect(getSupportedThinkingLevels(XAI_MODELS["grok-4.5"])).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(supportedLevels(known("grok-4.5"))).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(known("grok-4.5").thinkingLevelMap?.minimal).toBe("low");
    // Neither provider ever offers `off`, `xhigh`, or `max` for Grok 4.5.
    // Pi treats an absent key and an explicit null alike for these levels, so
    // assert the effective levels rather than the raw map shape: Pi 0.81 leaves
    // built-in `xhigh`/`max` undefined while 0.82 spells them out as null.
    for (const level of ["off", "xhigh", "max"] as const) {
      expect(getSupportedThinkingLevels(XAI_MODELS["grok-4.5"])).not.toContain(level);
      expect(supportedLevels(known("grok-4.5"))).not.toContain(level);
      expect(known("grok-4.5").thinkingLevelMap?.[level]).toBeNull();
    }
  });

  it("never advertises the API-key-only built-in grok-build-0.1 through xai-auth", () => {
    expect(XAI_MODELS["grok-build-0.1"]).toBeDefined();
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
    expect(extended.thinkingLevelMap?.max).toBeNull();
  });
});
