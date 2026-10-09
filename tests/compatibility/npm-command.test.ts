import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type NpmOptions = { env?: NodeJS.ProcessEnv; execPath?: string; platform?: NodeJS.Platform };
const { npmCommand, resolveNpmCli } = require("../../scripts/npm-command.js") as {
  npmCommand(args: string[], options?: NpmOptions): { command: string; args: string[] };
  resolveNpmCli(options?: NpmOptions): string;
};
const temporaryRoots: string[] = [];

function temporaryRoot() {
  // resolveNpmCli returns real paths; macOS tmpdir() sits under the /var -> /private/var symlink.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-npm-command-")));
  temporaryRoots.push(root);
  return root;
}

function writeCli(root: string, packageName = "npm") {
  const packageRoot = path.join(root, "node_modules", "npm");
  const cliPath = path.join(packageRoot, "bin", "npm-cli.js");
  mkdirSync(path.dirname(cliPath), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName }));
  writeFileSync(cliPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
  return cliPath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable npm command", () => {
  it("prefers a valid npm_execpath and preserves shell-sensitive arguments through a real child process", () => {
    const cliPath = writeCli(temporaryRoot());
    const args = ["pack", "a path with spaces", "semi;colon", "$(echo secret)", "quote\"value", "a&b", "line\nbreak"];
    const invocation = npmCommand(args, { env: { npm_execpath: cliPath, PATH: "" } });
    const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(invocation.command).toBe(process.execPath);
  });

  it("falls back to npm alongside Node when npm_execpath names another package manager", () => {
    const root = temporaryRoot();
    const cliPath = writeCli(root);
    expect(resolveNpmCli({ execPath: path.join(root, "node"), env: { npm_execpath: path.join(root, "yarn.js"), PATH: "" } }))
      .toBe(cliPath);
  });

  it("finds npm beside a PATH wrapper when Node is installed elsewhere", () => {
    const root = temporaryRoot();
    const cliPath = writeCli(path.join(root, "npm install with spaces"));
    expect(resolveNpmCli({ execPath: path.join(root, "node install", "node"), env: { Path: path.join(root, "npm install with spaces") } }))
      .toBe(cliPath);
  });

  it.runIf(process.platform !== "win32")("resolves a Unix npm symlink from PATH", () => {
    const root = temporaryRoot();
    const cliPath = writeCli(path.join(root, "npm package"));
    const binDirectory = path.join(root, "bin");
    mkdirSync(binDirectory);
    symlinkSync(cliPath, path.join(binDirectory, "npm"));
    expect(resolveNpmCli({ execPath: path.join(root, "node install", "node"), env: { PATH: binDirectory } }))
      .toBe(cliPath);
  });

  it("rejects a namesake CLI outside an npm package with a deterministic resolution error", () => {
    const root = temporaryRoot();
    const cliPath = writeCli(root, "another-package");
    expect(() => resolveNpmCli({ execPath: path.join(root, "node"), env: { npm_execpath: cliPath, PATH: "" } }))
      .toThrow(/Could not resolve npm-cli\.js from npm_execpath, the Node installation, or PATH/);
  });

  it("resolves the installed npm when invoked directly by Node without npm_execpath", () => {
    const env = { ...process.env };
    delete env.npm_execpath;
    const invocation = npmCommand(["--version"], { env });
    const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
