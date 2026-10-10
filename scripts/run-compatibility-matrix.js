#!/usr/bin/env node

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { npmCommand } = require("./npm-command.js");

const repoRoot = path.resolve(__dirname, "..");
const policy = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "compatibility", "pi-versions.json"), "utf8"),
);

function run(command, args, options = {}) {
  const printable = `${command} ${args.join(" ")}`;
  console.log(`\n> ${printable}`);
  const env = { ...process.env, ...options.env };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const invocation = command === "npm" ? npmCommand(args, { env }) : { command, args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env,
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(`${result.stdout || ""}${result.stderr || ""}`);
    throw new Error(`${printable} failed ${result.error ? `to start: ${result.error.message}` : `with exit ${result.status}`}`);
  }
  return result;
}

function resolveRequestedVersion(value) {
  if (value === "minimum") return policy.minimum;
  if (value === "latest") return policy.latest;
  assert.match(value || "", /^\d+\.\d+\.\d+$/, "Pass minimum, latest, or an exact Pi version");
  return value;
}

function installedVersion(packageRoot, packageName) {
  return JSON.parse(
    fs.readFileSync(path.join(packageRoot, "node_modules", ...packageName.split("/"), "package.json"), "utf8"),
  ).version;
}

function main() {
  const requested = resolveRequestedVersion(process.argv[2]);
  const candidate = process.argv.includes("--candidate");
  const endpoints = new Set([policy.minimum, policy.latest]);
  if (!candidate) {
    assert.ok(
      endpoints.has(requested),
      `${requested} is not a checked-in matrix endpoint; use --candidate for a temporary future-release evaluation`,
    );
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-xai-oauth-compat-${requested}-`));
  const packDirectory = path.join(root, "packed");
  const extractDirectory = path.join(root, "workspace");
  fs.mkdirSync(packDirectory, { recursive: true });
  fs.mkdirSync(extractDirectory, { recursive: true });

  try {
    const packResult = run("npm", ["pack", "--json", "--pack-destination", packDirectory], {
      capture: true,
    });
    const parsedPack = JSON.parse(packResult.stdout);
    const packEntries = Array.isArray(parsedPack) ? parsedPack : Object.values(parsedPack);
    assert.strictEqual(packEntries.length, 1, "npm pack must produce exactly one tarball");
    const tarballPath = path.join(packDirectory, packEntries[0].filename);
    run("tar", ["-xzf", tarballPath, "-C", extractDirectory]);

    const packageRoot = path.join(extractDirectory, "package");
    const manifestPath = path.join(packageRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const packageName of policy.packages) {
      manifest.devDependencies[packageName] = requested;
      if (candidate) manifest.peerDependencies[packageName] = requested;
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rmSync(path.join(packageRoot, "package-lock.json"), { force: true });
    fs.rmSync(path.join(packageRoot, "node_modules"), { recursive: true, force: true });

    console.log(
      `\nPi compatibility ${candidate ? "candidate" : "boundary"}: requested-ai=${requested} requested-agent=${requested}`,
    );
    run(
      "npm",
      [
        "install",
        "--strict-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
      ],
      { cwd: packageRoot },
    );

    const resolvedAi = installedVersion(packageRoot, policy.packages[0]);
    const resolvedAgent = installedVersion(packageRoot, policy.packages[1]);
    console.log(`Pi compatibility resolved: ai=${resolvedAi} agent=${resolvedAgent}`);
    assert.strictEqual(resolvedAi, requested, `Resolved ${policy.packages[0]} drifted from the requested version`);
    assert.strictEqual(resolvedAgent, requested, `Resolved ${policy.packages[1]} drifted from the requested version`);

    run("npm", ["ls", ...policy.packages, "--depth=0"], { cwd: packageRoot });
    const matrixEnv = {
      PI_COMPAT_MATRIX_VERSION: requested,
      ...(candidate ? { PI_COMPAT_CANDIDATE_PEER_VERSION: requested } : {}),
    };
    run("npm", ["test"], { cwd: packageRoot, env: matrixEnv });
    // Execute the extension's commands in a real Pi RPC process at this exact
    // Pi pair; the loader smoke and unit suites only cover registration and mocks.
    run("npm", ["run", "test:e2e"], {
      cwd: packageRoot,
      env: { ...matrixEnv, E2E_TELEMETRY_DISABLED: "1" },
    });
    run("npm", ["run", "typecheck"], { cwd: packageRoot, env: matrixEnv });
    console.log(`\nPi compatibility ${requested}: ok`);
  } finally {
    if (process.env.KEEP_PI_COMPAT_TEMP === "1") {
      console.log(`Compatibility workspace retained at ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

main();
