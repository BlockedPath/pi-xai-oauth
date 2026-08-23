import { constants, symlinkSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XAI_GROK_NATIVE_TOOL_NAME_MAP } from "../../extensions/xai/constants";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { registerGrokNativeTools } from "../../extensions/xai/tools/grok-native";
import { createExtensionHarness, toolExecutionContext } from "../fixtures/extension-api";
import { createTempDir } from "../fixtures/temp";

const openHooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string, flags: number | string | undefined) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: any[]) => {
      const path = String(args[0]);
      const flags = args[1] as number | string | undefined;
      openHooks.beforeOpen?.(path, flags);
      return await (actual.open as any)(...args);
    },
    // Old grep used pathname readFile, whose internal open does not go through
    // the mocked `open`. Hook it so a revert still loses the race.
    readFile: async (...args: any[]) => {
      openHooks.beforeOpen?.(String(args[0]), "r");
      return await (actual.readFile as any)(...args);
    },
  };
});

function isWriteOpen(flags: number | string | undefined): boolean {
  if (typeof flags === "number") {
    return (
      (flags & constants.O_WRONLY) === constants.O_WRONLY ||
      (flags & constants.O_RDWR) === constants.O_RDWR
    );
  }
  return typeof flags === "string" && flags.includes("w");
}

describe.runIf(process.platform !== "win32")("Grok-native leaf-symlink races", () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let outside: Awaited<ReturnType<typeof createTempDir>>;
  let h: ReturnType<typeof createExtensionHarness>;

  beforeEach(async () => {
    temp = await createTempDir("pi-xai-grok-race-");
    outside = await createTempDir("pi-xai-grok-race-outside-");
    h = createExtensionHarness();
    setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
    registerGrokNativeTools(h.api);
  });

  afterEach(async () => {
    openHooks.beforeOpen = undefined;
    setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
    await Promise.all([temp.cleanup(), outside.cleanup()]);
  });

  function tool(name: string) {
    const dispatchName =
      Object.entries(XAI_GROK_NATIVE_TOOL_NAME_MAP).find(([, publicName]) => publicName === name)?.[0] ??
      name;
    return h.tools.get(dispatchName);
  }

  async function run(name: string, params: any) {
    return tool(name).execute(
      "call",
      params,
      new AbortController().signal,
      () => {},
      toolExecutionContext(temp.path),
    );
  }

  it("still reads and replaces a regular workspace file", async () => {
    await writeFile(join(temp.path, "ok.txt"), "find-me old");
    const grepped = await run("grep", { pattern: "find-me", path: "." });
    expect(grepped.content[0].text).toMatch(/find-me/);
    await run("search_replace", {
      file_path: "ok.txt",
      old_string: "old",
      new_string: "new",
    });
    expect(await readFile(join(temp.path, "ok.txt"), "utf8")).toBe("find-me new");
  });

  it("refuses a search_replace write after the leaf is swapped for an outward symlink", async () => {
    const target = join(temp.path, "replace-target.txt");
    const leaked = join(outside.path, "secret.txt");
    await writeFile(target, "old");
    await writeFile(leaked, "OUTSIDE_SECRET");

    openHooks.beforeOpen = (path, flags) => {
      if (!path.endsWith(`${sep}replace-target.txt`) || !isWriteOpen(flags)) return;
      openHooks.beforeOpen = undefined;
      unlinkSync(path);
      symlinkSync(leaked, path);
    };

    await expect(
      run("search_replace", {
        file_path: "replace-target.txt",
        old_string: "old",
        new_string: "replacement",
      }),
    ).rejects.toThrow(/ELOOP|symbolic link/i);
    expect(await readFile(leaked, "utf8")).toBe("OUTSIDE_SECRET");
  });

  it("skips a grep read after the leaf is swapped for an outward symlink", async () => {
    const target = join(temp.path, "grep-target.txt");
    const leaked = join(outside.path, "secret.txt");
    await writeFile(target, "workspace-visible");
    await writeFile(leaked, "OUTSIDE_SECRET");

    openHooks.beforeOpen = (path) => {
      if (!path.endsWith(`${sep}grep-target.txt`)) return;
      openHooks.beforeOpen = undefined;
      unlinkSync(path);
      symlinkSync(leaked, path);
    };

    const result = await run("grep", { pattern: "OUTSIDE_SECRET", path: "." });
    expect(result.content[0].text).toBe("No matches found");
    expect(await readFile(leaked, "utf8")).toBe("OUTSIDE_SECRET");
  });
});
