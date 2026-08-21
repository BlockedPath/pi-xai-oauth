import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchXaiModelCatalog,
  normalizeXaiCatalogPayload,
  selectXaiModelCatalog,
  XaiCatalogCancelledError,
} from "../../extensions/xai/catalog";
import {
  XAI_CLI_MODELS_URL,
  XAI_CLIENT_IDENTIFIER,
  XAI_PROXY_CLIENT_VERSION,
  XAI_USER_AGENT,
  XAI_MODEL_CATALOG_CACHE_SCHEMA,
  XAI_MODEL_CATALOG_FRESH_TTL_MS,
  XAI_MODEL_CATALOG_MAX_BYTES,
  XAI_MODEL_CATALOG_MAX_STALE_MS,
} from "../../extensions/xai/constants";
import { XaiModelInputProvenance } from "../../extensions/xai/models";
import { createTempDir } from "../fixtures/temp";
import apiKeyOnlyFixture from "../fixtures/models-v2/api-key-only.json";
import { headerValue, jsonResponse } from "../fixtures/http";

const now = 2_000_000_000_000;
const token = "OAUTH_TOKEN_MUST_NEVER_REACH_CACHE";
let temp: Awaited<ReturnType<typeof createTempDir>>;
const additionsPayload = {
  data: [
    {
      model: "grok-4.5",
      name: "Grok 4.5",
      api_backend: "responses",
      context_window: 500_000,
      supports_reasoning_effort: true,
      reasoning_efforts: ["low", "medium", "high"],
    },
    { model: "oauth-new", api_backend: "responses", context_window: 100_000 },
  ],
};
const removalsPayload = {
  data: [
    {
      model: "grok-composer-2.5-fast",
      api_backend: "responses",
      context_window: 200_000,
    },
  ],
};
const additions = normalizeXaiCatalogPayload(additionsPayload);

async function writeCache(
  path: string,
  fetchedAt: number,
  models = additions,
  schemaVersion = XAI_MODEL_CATALOG_CACHE_SCHEMA,
) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion,
      fetchedAt,
      models,
    }),
  );
}

beforeEach(async () => {
  temp = await createTempDir("pi-xai-catalog-");
});
afterEach(async () => {
  await temp.cleanup();
});

describe("catalog cache selection", () => {
  it("uses a fresh cache without network and tightens permissions", async () => {
    const path = join(temp.path, "fresh", "models-v2.json");
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS + 1);
    await chmod(path, 0o644);
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl,
    });
    expect(selection.source).toBe("fresh-cache");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await selectXaiModelCatalog({ cachePath: path, now })).source).toBe(
      "curated-fallback",
    );
  });

  it("migrates schema 1 in memory without promoting legacy input to authenticated evidence", async () => {
    const path = join(temp.path, "legacy", "models-v2.json");
    const legacyModels = additions.map(({ inputProvenance: _inputProvenance, ...model }) => ({
      ...model,
      input: model.id === "grok-4.5" ? ["text"] : ["text", "image"],
    }));
    await writeCache(path, now - 1, legacyModels as any, 1);
    const fetchImpl = vi.fn(async () => {
      throw new Error("fresh migrated cache must not fetch");
    });

    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl,
    });

    expect(selection.source).toBe("fresh-cache");
    expect(selection.models.map(({ id }) => id)).toEqual(additions.map(({ id }) => id));
    expect(selection.models[0]).toMatchObject({
      input: ["text", "image"],
      inputProvenance: XaiModelInputProvenance.Known,
    });
    expect(selection.models[1]).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.Default,
    });
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes schema 2 on the next normal atomic refresh after loading schema 1", async () => {
    const path = join(temp.path, "legacy-refresh", "models-v2.json");
    const legacyModels = additions.map(({ inputProvenance: _inputProvenance, ...model }) => model);
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS, legacyModels as any, 1);

    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl: async () =>
        jsonResponse({
          data: [
            {
              model: "grok-4.5",
              api_backend: "responses",
              context_window: 500_000,
              acceptsImages: false,
            },
          ],
        }),
    });

    expect(selection.models.map(({ id }) => id)).toEqual(["grok-4.5"]);
    const cached = JSON.parse(await readFile(path, "utf8"));
    expect(cached.schemaVersion).toBe(2);
    expect(cached.models[0]).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    });
  });

  it("rejects malformed schema-2 provenance instead of treating it as fresh", async () => {
    const path = join(temp.path, "bad-provenance", "models-v2.json");
    const malformed = additions.map((model, index) =>
      index === 0 ? { ...model, inputProvenance: "authenticated" } : model,
    );
    await writeCache(path, now - 1, malformed as any);
    const fetchImpl = vi.fn(async () => jsonResponse(removalsPayload));

    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl,
    });

    expect(selection.source).toBe("remote");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects impossible acceptsImages provenance/input combinations", async () => {
    const path = join(temp.path, "bad-accepts-images", "models-v2.json");
    const malformed = additions.map((model, index) =>
      index === 0
        ? {
            ...model,
            input: ["image"],
            inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
          }
        : model,
    );
    await writeCache(path, now - 1, malformed as any);
    const fetchImpl = vi.fn(async () => jsonResponse(removalsPayload));

    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl,
    });

    expect(selection.source).toBe("remote");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refreshes stale data through only the pinned authenticated GET and replaces the cache", async () => {
    const path = join(temp.path, "stale", "models-v2.json");
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS);
    let request: { url: string; init: RequestInit } | undefined;
    const result = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl: async (url, init) => {
        request = { url: String(url), init: init! };
        return jsonResponse(removalsPayload);
      },
    });
    expect(result.source).toBe("remote");
    expect(result.models.map(({ id }) => id)).toEqual([
      "grok-composer-2.5-fast",
    ]);
    expect(request?.url).toBe(XAI_CLI_MODELS_URL);
    expect(request?.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(headerValue(request?.init.headers, "X-XAI-Token-Auth")).toBe(
      "xai-grok-cli",
    );
    expect(headerValue(request?.init.headers, "Authorization")).toBe(
      `Bearer ${token}`,
    );
    expect(headerValue(request?.init.headers, "Accept")).toBe(
      "application/json",
    );
    expect(headerValue(request?.init.headers, "User-Agent")).toBe(
      XAI_USER_AGENT,
    );
    expect(headerValue(request?.init.headers, "x-authenticateresponse")).toBe(
      "authenticate-response",
    );
    expect(headerValue(request?.init.headers, "x-grok-client-identifier")).toBe(
      XAI_CLIENT_IDENTIFIER,
    );
    expect(headerValue(request?.init.headers, "x-grok-client-version")).toBe(
      XAI_PROXY_CLIENT_VERSION,
    );
    expect(headerValue(request?.init.headers, "x-grok-client-mode")).toMatch(
      /^(interactive|headless)$/,
    );
    for (const name of [
      "x-grok-conv-id",
      "x-grok-req-id",
      "x-grok-session-id",
      "x-grok-model-override",
      "x-grok-agent-id",
      "x-grok-turn-idx",
      "x-grok-user-id",
      "x-grok-deployment-id",
    ]) {
      expect(headerValue(request?.init.headers, name)).toBeUndefined();
    }
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(token);
    expect(JSON.parse(text).models.map((model: any) => model.id)).toEqual([
      "grok-composer-2.5-fast",
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("forces discovery when credentials changed after a fresh cache", async () => {
    const path = join(temp.path, "changed", "models-v2.json");
    await writeCache(path, now - 1);
    const fetchImpl = vi.fn(async () => jsonResponse(removalsPayload));
    expect(
      (
        await selectXaiModelCatalog({
          credential: { access: token },
          credentialChangedAt: now,
          cachePath: path,
          now,
          fetchImpl,
        })
      ).source,
    ).toBe("remote");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "offline",
      async () => {
        throw new Error("offline");
      },
    ],
    [
      "oversized",
      async () =>
        jsonResponse({}, 200, {
          "Content-Length": String(XAI_MODEL_CATALOG_MAX_BYTES + 1),
        }),
    ],
    [
      "malformed success",
      async () => jsonResponse({ data: [{ model: "broken" }] }),
    ],
  ])("keeps eligible stale data after %s", async (_label, fetchImpl) => {
    const path = join(temp.path, "stale-fallback", "models-v2.json");
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS);
    const result = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl,
    });
    expect(result.source).toBe("stale-cache");
    expect(result.models.map(({ id }) => id)).toEqual(
      additions.map(({ id }) => id),
    );
  });

  it("does not commit after caller cancellation", async () => {
    const path = join(temp.path, "cancel", "models-v2.json");
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS);
    const before = await readFile(path, "utf8");
    const controller = new AbortController();
    let resolve!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((done) => {
      markStarted = done;
    });
    const pending = selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      forceRefresh: true,
      signal: controller.signal,
      fetchImpl: async () =>
        new Promise<Response>((done) => {
          resolve = done;
          markStarted();
        }),
    });
    await started;
    controller.abort();
    resolve(jsonResponse(removalsPayload));
    await expect(pending).rejects.toBeInstanceOf(XaiCatalogCancelledError);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("restores the previous cache when the commit guard flips after a successful rename", async () => {
    const path = join(temp.path, "post-write-guard", "models-v2.json");
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS);
    let checks = 0;
    await expect(
      selectXaiModelCatalog({
        credential: { access: token },
        cachePath: path,
        now,
        commitAllowed: () => ++checks < 3,
        fetchImpl: async () => jsonResponse(removalsPayload),
      }),
    ).rejects.toBeInstanceOf(XaiCatalogCancelledError);
    expect(
      JSON.parse(await readFile(path, "utf8")).models.map(
        (model: any) => model.id,
      ),
    ).toEqual(additions.map(({ id }) => id));
  });

  it("restores the previous cache when the commit guard changes", async () => {
    const path = join(temp.path, "guard", "models-v2.json");
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS);
    let checks = 0;
    await expect(
      selectXaiModelCatalog({
        credential: { access: token },
        cachePath: path,
        now,
        commitAllowed: () => ++checks < 4,
        fetchImpl: async () => jsonResponse(removalsPayload),
      }),
    ).rejects.toBeInstanceOf(XaiCatalogCancelledError);
    expect(
      JSON.parse(await readFile(path, "utf8")).models.map(
        (model: any) => model.id,
      ),
    ).toEqual(additions.map(({ id }) => id));
  });

  it("restores exact schema-1 contents after post-rename cancellation", async () => {
    const path = join(temp.path, "legacy-guard", "models-v2.json");
    const legacyModels = additions.map(({ inputProvenance: _inputProvenance, ...model }) => ({
      ...model,
      input: model.id === "grok-4.5" ? ["text"] : ["text", "image"],
    }));
    await writeCache(
      path,
      now - XAI_MODEL_CATALOG_FRESH_TTL_MS,
      legacyModels as any,
      1,
    );
    const before = await readFile(path, "utf8");
    let checks = 0;

    await expect(
      selectXaiModelCatalog({
        credential: { access: token },
        cachePath: path,
        now,
        commitAllowed: () => ++checks < 4,
        fetchImpl: async () => jsonResponse(removalsPayload),
      }),
    ).rejects.toBeInstanceOf(XaiCatalogCancelledError);

    expect(await readFile(path, "utf8")).toBe(before);
    expect(JSON.parse(before).schemaVersion).toBe(1);
  });

  it("invalidates stale entitlements after auth failure", async () => {
    const path = join(temp.path, "auth", "models-v2.json");
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS);
    const result = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl: async () => jsonResponse({}, 401),
    });
    expect(result).toMatchObject({
      source: "curated-fallback",
      needsAuthenticatedRefresh: false,
    });
    expect(result.models.map(({ id }) => id)).toEqual(["grok-4.6"]);
    expect(JSON.parse(await readFile(path, "utf8")).invalidated).toBe(true);
  });

  it("never reuses old-account cache after a forced transient failure", async () => {
    const path = join(temp.path, "forced", "models-v2.json");
    await writeCache(path, now - XAI_MODEL_CATALOG_FRESH_TTL_MS);
    const result = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      forceRefresh: true,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(result).toMatchObject({
      source: "curated-fallback",
      needsAuthenticatedRefresh: true,
    });
    expect(JSON.parse(await readFile(path, "utf8")).invalidated).toBe(true);
  });

  it("uses fallback for missing, too-old, and deferred credential states", async () => {
    const missing = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: join(temp.path, "missing.json"),
      now,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(missing).toMatchObject({
      source: "curated-fallback",
      needsAuthenticatedRefresh: true,
    });
    const oldPath = join(temp.path, "old", "models-v2.json");
    await writeCache(oldPath, now - XAI_MODEL_CATALOG_MAX_STALE_MS - 1);
    expect(
      (
        await selectXaiModelCatalog({
          credential: { access: token },
          cachePath: oldPath,
          now,
          fetchImpl: async () => {
            throw new Error("offline");
          },
        })
      ).source,
    ).toBe("curated-fallback");
    expect(
      await selectXaiModelCatalog({
        cachePath: join(temp.path, "none.json"),
        now,
        refreshWhenCredentialsAvailable: true,
      }),
    ).toMatchObject({
      source: "curated-fallback",
      needsAuthenticatedRefresh: true,
    });
  });

  it("suppresses fresh cache with an invalidation sidecar and clears it on success", async () => {
    const path = join(temp.path, "marker", "models-v2.json");
    await writeCache(path, now - 1);
    await writeFile(`${path}.invalidated`, `1:${now}\n`);
    const fetchImpl = vi.fn(async () => jsonResponse(removalsPayload));
    expect(
      (
        await selectXaiModelCatalog({
          credential: { access: token },
          cachePath: path,
          now: now + 1,
          fetchImpl,
        })
      ).source,
    ).toBe("remote");
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(stat(`${path}.invalidated`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists only normalized OAuth-safe models from a secret-bearing response", async () => {
    const path = join(temp.path, "secret-filter", "models-v2.json");
    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl: async () => jsonResponse(apiKeyOnlyFixture),
    });

    expect(selection.source).toBe("remote");
    expect(selection.models.map(({ id }) => id)).toEqual(["oauth-safe-model"]);
    const cache = await readFile(path, "utf8");
    expect(cache).not.toMatch(
      /MUST_NOT_REACH_CACHE|XAI_API_KEY|OAUTH_TOKEN_MUST_NEVER_REACH_CACHE/,
    );
  });

  it("persists normalized modality provenance without raw capability or identity fields", async () => {
    const path = join(temp.path, "modality-privacy", "models-v2.json");
    await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl: async () =>
        jsonResponse({
          data: [
            {
              model: "private-shape",
              api_backend: "responses",
              context_window: 100_000,
              acceptsImages: false,
              inputModalities: ["text", "image"],
              user_id: "IDENTITY_MUST_NOT_REACH_CACHE",
              endpoint: "ENDPOINT_MUST_NOT_REACH_CACHE",
            },
          ],
        }),
    });

    const cache = await readFile(path, "utf8");
    expect(cache).not.toMatch(
      /acceptsImages|inputModalities|IDENTITY_MUST_NOT_REACH_CACHE|ENDPOINT_MUST_NOT_REACH_CACHE|OAUTH_TOKEN_MUST_NEVER_REACH_CACHE/,
    );
    expect(JSON.parse(cache).models[0]).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    });
  });

  it("preserves deferred Pi refresh intent after a successful authenticated fetch", async () => {
    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      refreshWhenCredentialsAvailable: true,
      cachePath: join(temp.path, "deferred", "models-v2.json"),
      now,
      fetchImpl: async () => jsonResponse(additionsPayload),
    });

    expect(selection).toMatchObject({
      source: "remote",
      needsAuthenticatedRefresh: true,
    });
  });

  it("direct fetch normalizes successful catalog responses", async () => {
    await expect(
      fetchXaiModelCatalog(
        { access: token },
        { fetchImpl: async () => jsonResponse(additionsPayload) },
      ),
    ).resolves.toMatchObject({ kind: "success" });
  });

  it.each([408, 425, 429, 503])("classifies HTTP %s catalog responses as transient", async (status) => {
    await expect(
      fetchXaiModelCatalog(
        { access: token },
        { fetchImpl: async () => jsonResponse({}, status) },
      ),
    ).resolves.toEqual({ kind: "transient" });
  });

  it("classifies other non-success catalog HTTP statuses as permanent", async () => {
    await expect(
      fetchXaiModelCatalog(
        { access: token },
        { fetchImpl: async () => jsonResponse({}, 400) },
      ),
    ).resolves.toEqual({ kind: "permanent" });
  });
});
