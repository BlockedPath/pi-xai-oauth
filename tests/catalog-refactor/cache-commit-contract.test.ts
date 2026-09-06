import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  XAI_MODEL_CATALOG_CACHE_SCHEMA,
  XAI_MODEL_CATALOG_FRESH_TTL_MS,
} from "../../extensions/xai/constants";
import { jsonResponse } from "../fixtures/http";
import { createTempDir } from "../fixtures/temp";

const ioFailures = vi.hoisted(() => ({
  renameCache: false,
  unlinkCache: false,
}));

async function mockFsPromises() {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  const failure = (operation: "rename" | "unlink") =>
    Object.assign(new Error(`simulated ${operation} failure`), { code: "EACCES" });
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (ioFailures.renameCache && String(args[1]).endsWith("models-v2.json")) {
        throw failure("rename");
      }
      return actual.rename(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (ioFailures.unlinkCache && String(args[0]).endsWith("models-v2.json")) {
        throw failure("unlink");
      }
      return actual.unlink(...args);
    },
  };
}

vi.mock("fs/promises", mockFsPromises);
vi.mock("node:fs/promises", mockFsPromises);

const {
  selectXaiModelCatalog,
  XaiCatalogCancelledError,
} = await import("../../extensions/xai/catalog");

const now = 2_000_000_000_000;
const token = "TEST_OAUTH_TOKEN";
const oldModel = {
  id: "old-account-only",
  name: "Old Account Only",
  apiBackend: "responses",
  reasoning: false,
  input: ["text"],
  inputProvenance: "authenticated-accepts-images",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 16_384,
};
const remotePayload = {
  data: [
    {
      model: "new-account-only",
      api_backend: "responses",
      context_window: 100_000,
    },
  ],
};

let temp: Awaited<ReturnType<typeof createTempDir>>;

beforeEach(async () => {
  ioFailures.renameCache = false;
  ioFailures.unlinkCache = false;
  temp = await createTempDir("pi-xai-catalog-refactor-");
});

afterEach(async () => {
  ioFailures.renameCache = false;
  ioFailures.unlinkCache = false;
  await temp.cleanup();
});

describe("catalog cache commit contract", () => {
  it("uses an invalidation marker when neither replacement nor removal can commit", async () => {
    const path = join(temp.path, "marker", "models-v2.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({
      schemaVersion: XAI_MODEL_CATALOG_CACHE_SCHEMA,
      fetchedAt: now - XAI_MODEL_CATALOG_FRESH_TTL_MS,
      models: [oldModel],
    }));
    ioFailures.renameCache = true;
    ioFailures.unlinkCache = true;

    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl: async () => jsonResponse(remotePayload),
    });

    expect(selection.source).toBe("remote");
    expect(selection.models.map(({ id }) => id)).toEqual(["new-account-only"]);
    expect(JSON.parse(await readFile(path, "utf8")).models[0].id).toBe("old-account-only");
    expect(await readFile(`${path}.invalidated`, "utf8")).toBe(
      `${XAI_MODEL_CATALOG_CACHE_SCHEMA}:${now}\n`,
    );

    const retry = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now: now + 1,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(retry).toMatchObject({
      source: "curated-fallback",
      needsAuthenticatedRefresh: true,
    });
  });

  it("removes a newly written cache when ownership changes after commit", async () => {
    const path = join(temp.path, "cancelled-new", "models-v2.json");
    let checks = 0;

    await expect(
      selectXaiModelCatalog({
        credential: { access: token },
        cachePath: path,
        now,
        commitAllowed: () => ++checks < 4,
        fetchImpl: async () => jsonResponse(remotePayload),
      }),
    ).rejects.toBeInstanceOf(XaiCatalogCancelledError);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
