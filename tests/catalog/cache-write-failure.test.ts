import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  openMarker: false,
}));

async function mockFsPromises() {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  const fail = (operation: "rename" | "unlink" | "open") =>
    Object.assign(new Error(`simulated ${operation} failure`), { code: "EACCES" });
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (ioFailures.renameCache && String(args[1]).endsWith("models-v2.json")) {
        throw fail("rename");
      }
      return actual.rename(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (ioFailures.unlinkCache && String(args[0]).endsWith("models-v2.json")) {
        throw fail("unlink");
      }
      return actual.unlink(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (ioFailures.openMarker && String(args[0]).endsWith(".invalidated")) {
        throw fail("open");
      }
      return actual.open(...args);
    },
  };
}

vi.mock("fs/promises", mockFsPromises);
vi.mock("node:fs/promises", mockFsPromises);

const { selectXaiModelCatalog } = await import("../../extensions/xai/catalog");

const now = 2_000_000_000_000;
const token = "OAUTH_TOKEN_MUST_NEVER_REACH_CACHE";
const previousPayload = {
  schemaVersion: XAI_MODEL_CATALOG_CACHE_SCHEMA,
  fetchedAt: now - XAI_MODEL_CATALOG_FRESH_TTL_MS,
  models: [
    {
      id: "old-account-only",
      name: "Old Account Only",
      apiBackend: "responses",
      reasoning: false,
      input: ["text"],
      inputProvenance: "authenticated-accepts-images",
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 16_384,
    },
  ],
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
  ioFailures.openMarker = false;
  temp = await createTempDir("pi-xai-catalog-write-");
});

afterEach(async () => {
  ioFailures.renameCache = false;
  ioFailures.unlinkCache = false;
  ioFailures.openMarker = false;
  await temp.cleanup();
});

async function writePreviousCache(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(previousPayload));
}

describe("catalog atomic write failures", () => {
  it("drops an uncommitted previous-account cache after a successful fetch", async () => {
    const path = join(temp.path, "unlink-ok", "models-v2.json");
    await writePreviousCache(path);
    ioFailures.renameCache = true;

    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl: async () => jsonResponse(remotePayload),
    });

    expect(selection).toMatchObject({
      source: "remote",
      needsAuthenticatedRefresh: false,
    });
    expect(selection.models.map(({ id }) => id)).toEqual(["new-account-only"]);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses remote success when the previous entitlement cache is still readable", async () => {
    const path = join(temp.path, "still-readable", "models-v2.json");
    await writePreviousCache(path);
    ioFailures.renameCache = true;
    ioFailures.unlinkCache = true;
    ioFailures.openMarker = true;

    const selection = await selectXaiModelCatalog({
      credential: { access: token },
      cachePath: path,
      now,
      fetchImpl: async () => jsonResponse(remotePayload),
    });

    expect(selection).toMatchObject({
      source: "curated-fallback",
      needsAuthenticatedRefresh: true,
    });
    expect(selection.models.map(({ id }) => id)).not.toContain("new-account-only");
    expect(selection.models.map(({ id }) => id)).not.toContain("old-account-only");
    expect(JSON.parse(await readFile(path, "utf8")).models[0].id).toBe("old-account-only");
    expect(await readFile(path, "utf8")).not.toContain("new-account-only");
  });
});
