import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readdirFailure: { error?: NodeJS.ErrnoException } = {};

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) =>
      readdirFailure.error
        ? Promise.reject(readdirFailure.error)
        : (actual.readdir as any)(...args),
  };
});

const { registerGrokNativeTools } = await import("../../extensions/xai/tools/grok-native");
const { XAI_GROK_NATIVE_TOOL_NAME_MAP } = await import("../../extensions/xai/constants");
const { CURATED_FALLBACK_MODELS, KNOWN_XAI_MODEL_METADATA, setXaiRuntimeModels } = await import(
  "../../extensions/xai/models"
);
const { createExtensionHarness, toolExecutionContext } = await import("../fixtures/extension-api");
const { createTempDir } = await import("../fixtures/temp");

let temp: Awaited<ReturnType<typeof createTempDir>>;
let h: ReturnType<typeof createExtensionHarness>;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

async function runGrep(params: any) {
  const dispatchName = Object.entries(XAI_GROK_NATIVE_TOOL_NAME_MAP)
    .find(([, publicName]) => publicName === "grep")?.[0] ?? "grep";
  return h.tools.get(dispatchName).execute(
    "call",
    params,
    new AbortController().signal,
    () => {},
    toolExecutionContext(temp.path),
  );
}

beforeEach(async () => {
  readdirFailure.error = undefined;
  temp = await createTempDir("pi-xai-grok-search-errors-");
  h = createExtensionHarness();
  setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
  registerGrokNativeTools(h.api);
  await mkdir(join(temp.path, "src"));
  await writeFile(join(temp.path, "src/a.ts"), "export const VALUE = 1;\n");
});

afterEach(async () => {
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
  await temp.cleanup();
});

describe("Grok-native grep filesystem failures", () => {
  it("skips entries that are legitimately unreadable", async () => {
    readdirFailure.error = errno("EACCES");
    const result = await runGrep({ pattern: "VALUE", path: "src" });
    expect(result.content[0].text).toMatch(/No matches/i);
  });

  it("propagates unexpected filesystem failures instead of reporting an empty search", async () => {
    readdirFailure.error = errno("EIO");
    await expect(runGrep({ pattern: "VALUE", path: "src" })).rejects.toThrow(/EIO/);
  });
});
