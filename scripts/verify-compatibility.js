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
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, `Expected an exact stable semantic version, received ${JSON.stringify(version)}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function parsePeerRange(range) {
  const match = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range);
  assert.ok(match, `Peer range must use the explicit ">=minimum <next-line" policy form: ${range}`);
  return { minimum: match[1], upper: match[2] };
}

function satisfiesPeerRange(version, range = policy.peerRange) {
  const bounds = parsePeerRange(range);
  return compareVersions(version, bounds.minimum) >= 0 && compareVersions(version, bounds.upper) < 0;
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
    output.includes(policy.peerRange) || output.includes(policy.peerRange.replace(" ", "")),
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

  const bounds = parsePeerRange(policy.peerRange);
  assert.strictEqual(bounds.minimum, policy.minimum, "Peer lower bound must match policy.minimum");
  assert.strictEqual(bounds.upper, policy.unsupported.upper, "Upper sentinel must be the peer range's immediate excluded line");
  assert.ok(satisfiesPeerRange(policy.minimum), "Minimum release must satisfy the peer range");
  assert.ok(satisfiesPeerRange(policy.latest), "Latest matrix release must satisfy the peer range");
  assert.ok(!satisfiesPeerRange(policy.unsupported.older), "Older unsupported release must not satisfy the peer range");
  assert.ok(!satisfiesPeerRange(policy.unsupported.upper), "Upper breaking-line release must not satisfy the peer range");
  assert.ok(compareVersions(policy.minimum, policy.latest) <= 0, "Minimum must not exceed latest");

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
    for (const version of [policy.unsupported.older, policy.unsupported.upper]) {
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

main();
