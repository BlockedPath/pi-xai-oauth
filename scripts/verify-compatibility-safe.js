#!/usr/bin/env node

/**
 * Drop-in compatibility verifier wrapper that keeps the original policy,
 * registry, and unsupported checks while making pack verification ignore
 * gitignored local artifacts such as Finder `.DS_Store` files.
 */

const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ORIGINAL_VERIFIER = path.join(__dirname, "verify-compatibility.js");

function fail(message) {
  console.error(`compatibility: ${message}`);
  process.exit(1);
}

function runOriginal(command) {
  const result = spawnSync(process.execPath, [ORIGINAL_VERIFIER, command], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function jsonFromNpmPack() {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    for (const line of stdout.split(/\r?\n/).reverse()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        continue;
      }
    }
    fail(`Unable to parse npm pack output: ${error.message}`);
  }
}

function packedFiles() {
  const parsed = jsonFromNpmPack();
  const manifest = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  return new Set(
    files
      .filter((file) => file && file.type === "file" && typeof file.path === "string")
      .map((file) => file.path.replace(/\\/g, "/"))
  );
}

function expectedFiles() {
  let stdout;
  try {
    stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    fail(`Unable to list git-tracked and untracked non-ignored files: ${error.message}`);
  }
  const files = new Set();
  for (const entry of stdout.split(String.fromCharCode(0))) {
    const normalized = entry.trim().replace(/\\/g, "/");
    if (!normalized) continue;
    if (normalized === "node_modules" || normalized.startsWith("node_modules/")) continue;
    if (normalized === ".git" || normalized.startsWith(".git/")) continue;
    if (normalized === ".DS_Store" || normalized.endsWith("/.DS_Store")) continue;
    files.add(normalized);
  }
  return files;
}

function verifyPack() {
  const packed = packedFiles();
  const expected = expectedFiles();
  for (const file of expected) {
    if (!packed.has(file)) {
      fail(`Packed package is missing ${file}`);
    }
  }
  console.log(`Verified packed package contains ${expected.size} expected file(s).`);
}

function main() {
  const command = process.argv[2] ?? "all";
  if (command === "pack") {
    verifyPack();
    return;
  }
  if (command === "all") {
    runOriginal("policy");
    runOriginal("registry");
    verifyPack();
    runOriginal("unsupported");
    return;
  }
  runOriginal(command);
}

main();
