#!/usr/bin/env node

const assert = require("assert");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const policyPath = path.join(repoRoot, "compatibility", "pi-versions.json");
const packagePath = path.join(repoRoot, "package.json");
const lockPath = path.join(repoRoot, "package-lock.json");
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${source}`);
  }
}

const policy = parseJson(fs.readFileSync(policyPath, "utf8"), policyPath);

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  assert.ok(match, `Expected an exact stable semantic version, received ${JSON.stringify(version)}`);
  const parts = match.slice(1).map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Version components must be safe integers");
  return parts;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/** Parse ordered, separated stable-version intervals with explicit lower and upper bounds. */
function parsePeerRange(range) {
  assert.strictEqual(typeof range, "string", "Peer range must be a string");
  const intervals = range.split(" || ").map((part) => {
    const match = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(part);
    assert.ok(match, `Peer range must use bounded ">=minimum <upper" intervals joined by " || ": ${range}`);
    const bounds = { minimum: match[1], upper: match[2] };
    assert.ok(compareVersions(bounds.minimum, bounds.upper) < 0, "Peer intervals must not be empty or inverted");
    return bounds;
  });
  for (let index = 1; index < intervals.length; index++) {
    assert.ok(
      compareVersions(intervals[index - 1].upper, intervals[index].minimum) < 0,
      "Peer intervals must be ordered and separated by an excluded gap",
    );
  }
  return intervals;
}

/** Check stable-version membership in the union of supported peer intervals. */
function satisfiesPeerRange(version, range = policy.peerRange) {
  return parsePeerRange(range).some((bounds) =>
    compareVersions(version, bounds.minimum) >= 0 && compareVersions(version, bounds.upper) < 0);
}

/** Validate matrix boundaries and explicit negative fixtures against the supported intervals. */
function verifyRangePolicy(activePolicy) {
  const intervals = parsePeerRange(activePolicy.peerRange);
  const first = intervals[0];
  const last = intervals.at(-1);
  const excluded = activePolicy.unsupported.excluded === undefined ? [] : activePolicy.unsupported.excluded;
  assert.ok(Array.isArray(excluded), "Excluded releases must be an array");
  assert.strictEqual(new Set(excluded).size, excluded.length, "Excluded releases must be unique");
  assert.strictEqual(first.minimum, activePolicy.minimum, "Peer lower bound must match policy.minimum");
  assert.strictEqual(last.upper, activePolicy.unsupported.upper, "Upper sentinel must match the final excluded bound");
  assert.ok(
    compareVersions(activePolicy.latest, last.minimum) >= 0 && compareVersions(activePolicy.latest, last.upper) < 0,
    "Latest matrix release must belong to the final supported interval",
  );
  assert.ok(compareVersions(activePolicy.unsupported.older, first.minimum) < 0, "Older sentinel must precede the peer lower bound");
  for (const version of excluded) {
    assert.ok(
      compareVersions(version, first.minimum) >= 0 && compareVersions(version, last.upper) < 0,
      `Excluded release ${version} must lie inside the overall range bounds`,
    );
    assert.ok(!satisfiesPeerRange(version, activePolicy.peerRange), `Excluded release ${version} must not be supported`);
  }
  for (const bounds of intervals.slice(0, -1)) {
    assert.ok(excluded.includes(bounds.upper), `Internal gap at ${bounds.upper} must have an explicit negative fixture`);
  }
}

function readJson(filePath) {
  return parseJson(fs.readFileSync(filePath, "utf8"), filePath);
}

function listGitVisibleFiles(directory) {
  const relativeDirectory = path.relative(repoRoot, directory).split(path.sep).join("/");
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", relativeDirectory],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  return output
    .split(String.fromCharCode(0))
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

function run(command, args, options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (options.expectFailure) {
    assert.notStrictEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly succeeded`);
  } else if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}\n${result.stdout || ""}${result.stderr || ""}`,
    );
  }
  return result;
}

function assertPeerDiagnostics(output, version) {
  assert.match(output, /ERESOLVE|peer dependency|Conflicting peer dependency/i);
  assert.ok(
    policy.packages.some((packageName) => output.includes(packageName)),
    `Expected npm peer diagnostics to name a Pi peer for ${version}`,
  );
  assert.ok(
    output.replace(/\s+/g, "").includes(policy.peerRange.replace(/\s+/g, "")),
    `Expected npm peer diagnostics to include ${policy.peerRange} for ${version}`,
  );
}

function verifyPolicy() {
  assert.deepStrictEqual(policy.packages, [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
  ]);

  const manifest = readJson(packagePath);
  const expectedDevelopmentVersion = process.env.PI_COMPAT_MATRIX_VERSION || policy.latest;
  const expectedPeerRange = process.env.PI_COMPAT_CANDIDATE_PEER_VERSION || policy.peerRange;
  const ranges = policy.packages.map((packageName) => manifest.peerDependencies?.[packageName]);
  assert.ok(ranges.every((range) => range === expectedPeerRange), "Pi peer ranges must match the active compatibility policy");
  assert.strictEqual(new Set(ranges).size, 1, "Pi peer ranges must remain aligned");

  verifyRangePolicy(policy);

  for (const packageName of policy.packages) {
    assert.strictEqual(
      manifest.devDependencies?.[packageName],
      expectedDevelopmentVersion,
      `${packageName} development metadata must be exact at ${expectedDevelopmentVersion}`,
    );
  }

  if (!process.env.PI_COMPAT_MATRIX_VERSION) {
    const lock = readJson(lockPath);
    const lockRoot = lock.packages?.[""];
    assert.ok(lockRoot, "package-lock.json must contain root package metadata");
    for (const packageName of policy.packages) {
      assert.strictEqual(lockRoot.peerDependencies?.[packageName], policy.peerRange);
      assert.strictEqual(lockRoot.devDependencies?.[packageName], policy.latest);
      assert.strictEqual(
        lock.packages?.[`node_modules/${packageName}`]?.version,
        policy.latest,
        `The root lock entry for ${packageName} must resolve the checked-in latest release`,
      );
    }

    const workflow = fs.readFileSync(workflowPath, "utf8");
    assert.match(workflow, /verify-compatibility\.js matrix/);
    assert.match(workflow, /fromJSON\(needs\.policy\.outputs\.versions\)/);
    assert.doesNotMatch(
      workflow,
      /pi-version:\s*\[\s*["']?\d+\.\d+\.\d+/,
      "CI must consume matrix endpoints from compatibility/pi-versions.json instead of duplicating them",
    );
  }

  console.log(
    `compatibility policy: peers=${policy.peerRange} minimum=${policy.minimum} latest=${policy.latest}`,
  );
}

function registryVersions(packageName) {
  const output = execFileSync(
    "npm",
    ["view", `${packageName}@${policy.peerRange}`, "version", "--json"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = parseJson(output, `${packageName} registry response`);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((version) => typeof version === "string");
}

function verifyRegistry() {
  for (const packageName of policy.packages) {
    const versions = registryVersions(packageName).filter((version) => /^\d+\.\d+\.\d+$/.test(version));
    assert.ok(versions.includes(policy.minimum), `${packageName}@${policy.minimum} must remain published`);
    versions.sort(compareVersions);
    assert.strictEqual(
      versions.at(-1),
      policy.latest,
      `${packageName} has a newer release inside ${policy.peerRange}; review it and deliberately update policy.latest`,
    );
  }
  console.log(`registry policy: latest allowed release is exactly ${policy.latest} for both Pi peers`);
}

function packProject() {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-xai-oauth-pack-"));
  try {
    const result = run("npm", ["pack", "--json", "--pack-destination", outputDirectory]);
    const parsed = JSON.parse(result.stdout);
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
    assert.strictEqual(entries.length, 1, "npm pack must produce exactly one tarball");
    return {
      outputDirectory,
      tarballPath: path.join(outputDirectory, entries[0].filename),
      files: entries[0].files.map((entry) => entry.path),
    };
  } catch (error) {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

function verifyPackedPackage() {
  const packed = packProject();
  try {
    const manifestText = execFileSync("tar", ["-xOf", packed.tarballPath, "package/package.json"], {
      encoding: "utf8",
    });
    const sourceManifest = readJson(packagePath);
    const packedManifest = JSON.parse(manifestText);
    assert.strictEqual(packedManifest.name, sourceManifest.name);
    assert.strictEqual(packedManifest.version, sourceManifest.version);
    for (const packageName of policy.packages) {
      assert.strictEqual(packedManifest.peerDependencies?.[packageName], policy.peerRange);
    }

    const required = [
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "compatibility/pi-versions.json",
      "extensions/xai-oauth.ts",
      "extensions/xai/usage.ts",
      "scripts/verify-compatibility.js",
      "scripts/run-compatibility-matrix.js",
      "scripts/prepare-github-package.js",
      "scripts/verify-github-package.js",
      "scripts/verify-extension-loader.mjs",
      "vitest.config.mts",
      "tsconfig.json",
      ...listGitVisibleFiles(path.join(repoRoot, "tests")),
    ];
    for (const file of required) assert.ok(packed.files.includes(file), `Packed package is missing ${file}`);

    const forbidden = [
      "node_modules/",
      ".git/",
      ".scaffold/",
      ".pi-subagents/",
      ".agents/",
      "coverage/",
      "docs/diagrams/",
      "skills-lock.json",
      ".env",
      "auth.json",
    ];
    for (const file of packed.files) {
      assert.ok(!forbidden.some((prefix) => file === prefix || file.startsWith(prefix)), `Packed forbidden path: ${file}`);
    }
    console.log(`packed manifest: ${packed.files.length} files with peer range ${policy.peerRange}`);
  } finally {
    fs.rmSync(packed.outputDirectory, { recursive: true, force: true });
  }
}

function writeStubPackage(root, packageName, version) {
  const slug = packageName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const sourceRoot = path.join(root, slug);
  const packageDirectory = path.join(sourceRoot, "package");
  const tarballPath = path.join(root, `${slug}-${version}.tgz`);
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
  );
  execFileSync("tar", ["-czf", tarballPath, "-C", sourceRoot, "package"]);
  return tarballPath;
}

function writeConsumer(directory, tarballPath, version, stubRoot) {
  const dependencies = { "pi-xai-oauth": `file:${tarballPath}` };
  for (const packageName of policy.packages) {
    dependencies[packageName] = `file:${writeStubPackage(stubRoot, packageName, version)}`;
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: "pi-peer-negative-fixture", private: true, version: "1.0.0", dependencies }, null, 2)}\n`,
  );
}

function verifyUnsupportedInstalls() {
  const packed = packProject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-xai-oauth-peer-negative-"));
  try {
    for (const version of [policy.unsupported.older, ...(policy.unsupported.excluded || []), policy.unsupported.upper]) {
      const strictDirectory = path.join(root, version, "strict");
      writeConsumer(strictDirectory, packed.tarballPath, version, path.join(root, version, "strict-stubs"));
      const strict = run(
        "npm",
        ["install", "--strict-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
        { cwd: strictDirectory, expectFailure: true },
      );
      assertPeerDiagnostics(`${strict.stdout}\n${strict.stderr}`, version);

      const warningDirectory = path.join(root, version, "warning");
      writeConsumer(warningDirectory, packed.tarballPath, version, path.join(root, version, "warning-stubs"));
      const warning = run(
        "npm",
        ["install", "--force", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
        { cwd: warningDirectory },
      );
      assertPeerDiagnostics(`${warning.stdout}\n${warning.stderr}`, version);
      console.log(`unsupported peer ${version}: strict install rejected; forced install emitted a peer warning`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(packed.outputDirectory, { recursive: true, force: true });
  }
}

function printMatrix() {
  process.stdout.write(`${JSON.stringify([policy.minimum, policy.latest])}\n`);
}

function main() {
  const command = process.argv[2] || "policy";
  if (command === "matrix") return printMatrix();
  if (command === "policy") return verifyPolicy();
  if (command === "registry") return verifyRegistry();
  if (command === "pack") return verifyPackedPackage();
  if (command === "unsupported") return verifyUnsupportedInstalls();
  if (command === "all") {
    verifyPolicy();
    verifyRegistry();
    verifyPackedPackage();
    verifyUnsupportedInstalls();
    return;
  }
  throw new Error(`Unknown compatibility verification command: ${command}`);
}

if (require.main === module) main();

module.exports = { parsePeerRange, satisfiesPeerRange, verifyRangePolicy };
