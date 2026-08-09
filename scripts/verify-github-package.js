#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const policy = require("../compatibility/pi-versions.json");
const sourceManifest = require("../package.json");
const repoRoot = path.resolve(__dirname, "..");
const {
  GITHUB_PACKAGE_NAME,
  GITHUB_REGISTRY,
  prepareGithubPackage,
} = require("./prepare-github-package.js");

function parsePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.strictEqual(entries.length, 1, "npm pack must produce exactly one result");
  assert.strictEqual(typeof entries[0]?.filename, "string", "npm pack must report a filename");
  assert.strictEqual(path.basename(entries[0].filename), entries[0].filename, "npm pack filename must be safe");
  return entries[0];
}

function packPackage(packagePath, destination, canonical = false) {
  fs.mkdirSync(destination, { recursive: true });
  const args = canonical
    ? ["pack", "--json", "--pack-destination", destination]
    : ["pack", packagePath, "--json", "--pack-destination", destination];
  const output = execFileSync("npm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const result = parsePackResult(output);
  return {
    result,
    tarballPath: path.join(destination, result.filename),
  };
}

function extractTarball(tarballPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", destination], { stdio: "inherit" });
  return path.join(destination, "package");
}

function contentDigests(root, relative = "") {
  const current = path.join(root, relative);
  const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const digests = {};
  for (const entry of entries) {
    const entryRelative = path.join(relative, entry.name);
    if (entryRelative === "package.json") continue;
    const entryPath = path.join(root, entryRelative);
    if (entry.isDirectory()) {
      Object.assign(digests, contentDigests(root, entryRelative));
      continue;
    }
    assert.ok(entry.isFile(), `Package contains unsupported non-file entry: ${entryRelative}`);
    const stat = fs.statSync(entryPath);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex");
    digests[entryRelative] = `${(stat.mode & 0o777).toString(8)}:${hash}`;
  }
  return digests;
}

const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-xai-github-package-check-"));
try {
  const canonical = packPackage(repoRoot, path.join(outputRoot, "canonical-archive"), true);
  const canonicalPackage = extractTarball(canonical.tarballPath, path.join(outputRoot, "canonical"));
  const preparedPackage = prepareGithubPackage(
    canonical.tarballPath,
    path.join(outputRoot, "prepared-mirror"),
  );
  const mirror = packPackage(preparedPackage, path.join(outputRoot, "mirror-archive"));
  const mirrorPackage = extractTarball(mirror.tarballPath, path.join(outputRoot, "mirror"));
  const manifest = JSON.parse(fs.readFileSync(path.join(mirrorPackage, "package.json"), "utf8"));

  assert.strictEqual(manifest.name, GITHUB_PACKAGE_NAME);
  assert.strictEqual(manifest.version, sourceManifest.version);
  assert.strictEqual(manifest.publishConfig?.registry, GITHUB_REGISTRY);
  assert.deepStrictEqual(manifest.peerDependencies, sourceManifest.peerDependencies);
  assert.deepStrictEqual(
    mirror.result.files.map((entry) => entry.path).sort(),
    canonical.result.files.map((entry) => entry.path).sort(),
    "GitHub mirror file paths must match the canonical npmjs tarball",
  );
  assert.deepStrictEqual(
    contentDigests(mirrorPackage),
    contentDigests(canonicalPackage),
    "GitHub mirror non-manifest bytes and modes must match the canonical npmjs tarball",
  );
  for (const packageName of policy.packages) {
    assert.strictEqual(manifest.peerDependencies?.[packageName], policy.peerRange);
  }

  const preparedSetup = require(path.join(mirrorPackage, "bin", "setup.js"));
  assert.strictEqual(preparedSetup.PACKAGE_NAME, GITHUB_PACKAGE_NAME);
  assert.strictEqual(preparedSetup.NPM_SPEC, `npm:${GITHUB_PACKAGE_NAME}`);
  assert.ok(
    preparedSetup.DISTRIBUTION_PACKAGE_NAMES.includes(sourceManifest.name),
    "GitHub mirror must recognize the npmjs distribution as an alias",
  );

  console.log(
    `GitHub package mirror: ${manifest.name}@${manifest.version} matches ${canonical.result.files.length} canonical files for ${GITHUB_REGISTRY}`,
  );
} finally {
  fs.rmSync(outputRoot, { recursive: true, force: true });
}
