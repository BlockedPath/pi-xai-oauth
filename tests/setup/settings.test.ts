import { createRequire } from "node:module";
import nodeFs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "../fixtures/temp";
const require = createRequire(import.meta.url);
const setup = require("../../bin/setup.js") as {
  getNpmPackageName(source: string): string | undefined;
  pruneDuplicatePackageEntries(entries: any[], settingsPath: string, packageName?: string): any;
  updateSettings(path: string): boolean;
};
let temp: Awaited<ReturnType<typeof createTempDir>>;
let settingsPath: string;
let localXai: string;
let localOther: string;
beforeEach(async () => {
  temp = await createTempDir("pi-xai-setup-");
  settingsPath = join(temp.path, ".pi/agent/settings.json");
  const xai = join(temp.path, "projects/pi-xai-oauth");
  const other = join(temp.path, "projects/other");
  await mkdir(xai, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(
    join(xai, "package.json"),
    JSON.stringify({ name: "pi-xai-oauth" }),
  );
  await writeFile(
    join(other, "package.json"),
    JSON.stringify({ name: "other-pkg" }),
  );
  localXai = "../../projects/pi-xai-oauth";
  localOther = "../../projects/other";
});
afterEach(async () => temp.cleanup());
describe("setup settings", () => {
  it.each([
    ["npm:pi-xai-oauth", "pi-xai-oauth"],
    ["npm:pi-xai-oauth@1.3.0", "pi-xai-oauth"],
    ["npm:@scope/pkg@1.2.3", "@scope/pkg"],
    ["git:github.com/user/repo", undefined],
  ])("parses %s", (source, expected) =>
    expect(setup.getNpmPackageName(source)).toBe(expected),
  );
  it("prunes local duplicates while retaining npm and unrelated entries", () => {
    expect(
      setup.pruneDuplicatePackageEntries(
        [localXai, "npm:pi-xai-oauth", localOther],
        settingsPath,
      ),
    ).toEqual({
      packages: ["npm:pi-xai-oauth", localOther],
      removed: [localXai],
      addedNpmPackage: false,
    });
  });
  it("prunes object local entries and adds npm when absent", () => {
    expect(
      setup.pruneDuplicatePackageEntries(
        [{ source: localXai, extensions: ["./extensions"] }],
        settingsPath,
      ),
    ).toEqual({
      packages: ["npm:pi-xai-oauth"],
      removed: [localXai],
      addedNpmPackage: true,
    });
  });
  it("treats npmjs and GitHub Packages distributions as one package", () => {
    expect(
      setup.pruneDuplicatePackageEntries(
        ["npm:pi-xai-oauth", "npm:@blockedpath/pi-xai-oauth", localXai, "npm:other"],
        settingsPath,
        "@blockedpath/pi-xai-oauth",
      ),
    ).toEqual({
      packages: ["npm:@blockedpath/pi-xai-oauth", "npm:other"],
      removed: ["npm:pi-xai-oauth", localXai],
      addedNpmPackage: false,
    });

    expect(
      setup.pruneDuplicatePackageEntries(
        ["npm:@blockedpath/pi-xai-oauth", "npm:other"],
        settingsPath,
      ),
    ).toEqual({
      packages: ["npm:@blockedpath/pi-xai-oauth", "npm:other"],
      removed: [],
      addedNpmPackage: false,
    });
  });
  it("writes pruned packages and preserves package-owned xai-auth defaults", async () => {
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        packages: [localXai, "npm:pi-xai-oauth"],
        defaultProvider: "xai-auth",
        defaultModel: "grok-4.5",
        defaultThinkingLevel: "high",
        unrelated: true,
      }),
    );
    expect(setup.updateSettings(settingsPath)).toBe(true);
    const value = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(value).toMatchObject({
      packages: ["npm:pi-xai-oauth"],
      defaultProvider: "xai-auth",
      defaultModel: "grok-4.5",
      defaultThinkingLevel: "high",
      unrelated: true,
    });
  });
  it("defaults missing provider to native xai without overwriting other providers", async () => {
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        packages: ["npm:other"],
        defaultModel: "some-other-model",
        defaultThinkingLevel: "low",
      }),
    );
    setup.updateSettings(settingsPath);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      packages: ["npm:other", "npm:pi-xai-oauth"],
      defaultProvider: "xai",
      defaultModel: "grok-4.5",
      defaultThinkingLevel: "high",
    });

    // An unrelated provider owns its own model selection. Seeding a Grok model
    // next to it would leave the user on an impossible provider/model pair.
    await writeFile(
      settingsPath,
      JSON.stringify({
        packages: ["npm:pi-xai-oauth"],
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        defaultThinkingLevel: "medium",
      }),
    );
    setup.updateSettings(settingsPath);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      packages: ["npm:pi-xai-oauth"],
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      defaultThinkingLevel: "medium",
    });
  });
  it("fills blank xAI defaults but keeps a deliberate xAI model choice", async () => {
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        packages: ["npm:pi-xai-oauth"],
        defaultProvider: "xai",
        defaultModel: "grok-4-fast",
        defaultThinkingLevel: "low",
      }),
    );
    setup.updateSettings(settingsPath);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      defaultProvider: "xai",
      defaultModel: "grok-4-fast",
      defaultThinkingLevel: "low",
    });

    await writeFile(
      settingsPath,
      JSON.stringify({
        packages: ["npm:pi-xai-oauth"],
        defaultProvider: "xai-auth",
        defaultModel: "",
      }),
    );
    setup.updateSettings(settingsPath);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      defaultProvider: "xai-auth",
      defaultModel: "grok-4.5",
      defaultThinkingLevel: "high",
    });
  });
  it("keeps unparseable settings intact when no backup can be written", async () => {
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, "{ not json");
    vi.spyOn(nodeFs, "copyFileSync").mockImplementation(() => {
      throw new Error("backup denied");
    });
    const write = vi.spyOn(nodeFs, "writeFileSync");

    expect(setup.updateSettings(settingsPath)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(settingsPath, "utf8")).toBe("{ not json");
  });
  it("reports a failed settings write instead of claiming success", async () => {
    vi.spyOn(nodeFs, "writeFileSync").mockImplementation(() => {
      throw new Error("read-only filesystem");
    });
    expect(setup.updateSettings(settingsPath)).toBe(false);
  });
});
