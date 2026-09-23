#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageNames = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
];

async function resolvePackage(name) {
	let current = dirname(fileURLToPath(import.meta.resolve(name)));
	for (;;) {
		const manifestPath = join(current, "package.json");
		try {
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			if (manifest.name === name) return { root: current, manifest };
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		assert.notEqual(parent, current, `could not resolve package root for ${name}`);
		current = parent;
	}
}

async function runCli(cliPath, args, options) {
	return execFileAsync(process.execPath, [cliPath, ...args], {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		killSignal: "SIGKILL",
		maxBuffer: 1024 * 1024,
		timeout: 20_000,
	});
}

function isolatedEnv({ agentDir, home, preloadPath, packageDir, prefix, recordPath }) {
	const npmCache = join(home, ".npm-cache");
	const npmGlobalConfig = join(home, ".npm-globalrc");
	const npmPrefix = join(home, ".npm-prefix");
	const npmUserConfig = join(home, ".npmrc");
	const env = {
		...process.env,
		HOME: home,
		NODE_OPTIONS: "--unhandled-rejections=strict",
		NPM_CONFIG_CACHE: npmCache,
		NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
		NPM_CONFIG_OFFLINE: "true",
		NPM_CONFIG_PREFIX: npmPrefix,
		NPM_CONFIG_USERCONFIG: npmUserConfig,
		USERPROFILE: home,
		npm_config_cache: npmCache,
		npm_config_globalconfig: npmGlobalConfig,
		npm_config_offline: "true",
		npm_config_prefix: npmPrefix,
		npm_config_userconfig: npmUserConfig,
		PI_CLI_SMOKE_PREFIX: prefix,
		PI_CLI_SMOKE_RECORD: recordPath,
		PI_CODING_AGENT_DIR: agentDir,
	};
	delete env.PI_OFFLINE;
	delete env.PI_SKIP_VERSION_CHECK;
	delete env.PI_MANAGED_INSTALL_ROOT;
	delete env.PI_PACKAGE_DIR;
	if (packageDir) env.PI_PACKAGE_DIR = packageDir;
	if (preloadPath) {
		const preloadOption = `--import=${pathToFileURL(preloadPath).href}`;
		env.NODE_OPTIONS = `${env.NODE_OPTIONS} ${preloadOption}`;
	}
	return env;
}

async function readInvocations(recordPath) {
	try {
		return (await readFile(recordPath, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

const installed = await Promise.all(packageNames.map(resolvePackage));
const [piAi, piCodingAgent] = installed;
assert.equal(
	piAi.manifest.version,
	piCodingAgent.manifest.version,
	"installed Pi peer versions should match",
);
const expectedVersion = process.env.PI_COMPAT_MATRIX_VERSION || piCodingAgent.manifest.version;
for (const { manifest } of installed) {
	assert.equal(
		manifest.version,
		expectedVersion,
		`${manifest.name} should match the compatibility matrix version`,
	);
}

const cliRelativePath = piCodingAgent.manifest.bin?.pi;
assert.equal(typeof cliRelativePath, "string", "Pi package should expose its CLI path");
const cliPath = join(piCodingAgent.root, cliRelativePath);
const sandbox = await mkdtemp(join(tmpdir(), "pi-xai-cli-"));

try {
	const shimPath = join(sandbox, "npm-shim.mjs");
	const preloadPath = join(sandbox, "fetch-preload.mjs");
	await writeFile(
		shimPath,
		`import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length === 2 && args[0] === "root" && args[1] === "-g") {
	console.log(join(process.env.PI_CLI_SMOKE_PREFIX, "lib", "node_modules"));
} else {
	appendFileSync(process.env.PI_CLI_SMOKE_RECORD, JSON.stringify(args) + "\\n");
	const prefixIndex = args.indexOf("--prefix");
	if (args.includes("pi-xai-oauth@latest")) {
		const expectedPrefix = join(process.env.PI_CODING_AGENT_DIR, "npm");
		assert.notEqual(prefixIndex, -1, "extension update must include --prefix");
		assert.equal(args[prefixIndex + 1], expectedPrefix, "extension update prefix must stay inside the temp agent dir");
		const packageDir = join(expectedPrefix, "node_modules", "pi-xai-oauth");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pi-xai-oauth", version: "9.9.9" }));
	}
}
`,
		"utf8",
	);
	await writeFile(
		preloadPath,
		`const fetchStub = async (input) => {
	const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
	if (url !== "https://pi.dev/api/latest-version") {
		throw new Error(\`Unexpected network request: \${url}\`);
	}
	return Response.json({
		version: "9.9.9",
		packageName: "@earendil-works/pi-coding-agent",
	});
};
// Pi 0.87 installs its bundled undici globals during startup; keep the smoke's fetch boundary in place.
Object.defineProperty(globalThis, "fetch", {
	configurable: true,
	get: () => fetchStub,
	set: () => {},
});
`,
		"utf8",
	);

	const versionHome = join(sandbox, "version-home");
	const versionCwd = join(sandbox, "version-cwd");
	const versionAgentDir = join(versionHome, ".pi", "agent");
	await Promise.all([
		mkdir(versionAgentDir, { recursive: true }),
		mkdir(versionCwd, { recursive: true }),
	]);
	const versionResult = await runCli(cliPath, ["--version"], {
		cwd: versionCwd,
		env: isolatedEnv({ agentDir: versionAgentDir, home: versionHome, preloadPath }),
	});
	assert.equal(versionResult.stdout.trim(), expectedVersion, "pi --version should match the installed Pi peers");

	const selfHome = join(sandbox, "self-home");
	const selfCwd = join(sandbox, "self-cwd");
	const selfAgentDir = join(selfHome, ".pi", "agent");
	const selfPrefix = join(sandbox, "self-prefix");
	const selfRecordPath = join(sandbox, "self-invocations.jsonl");
	const fakePackageDir = join(
		selfPrefix,
		"lib",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	);
	await Promise.all([
		mkdir(selfAgentDir, { recursive: true }),
		mkdir(selfCwd, { recursive: true }),
		mkdir(fakePackageDir, { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(selfAgentDir, "settings.json"),
			JSON.stringify({ npmCommand: [process.execPath, shimPath] }),
			"utf8",
		),
		writeFile(
			join(fakePackageDir, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0" }),
			"utf8",
		),
	]);
	await runCli(cliPath, ["update"], {
		cwd: selfCwd,
		env: isolatedEnv({
			agentDir: selfAgentDir,
			home: selfHome,
			packageDir: fakePackageDir,
			prefix: selfPrefix,
			preloadPath,
			recordPath: selfRecordPath,
		}),
	});
	const selfInvocations = await readInvocations(selfRecordPath);
	assert.equal(
		selfInvocations.length,
		1,
		`bare pi update should dispatch one self-install command: ${JSON.stringify(selfInvocations)}`,
	);
	const selfArgs = selfInvocations[0];
	for (const expectedArg of [
		"install",
		"-g",
		"--ignore-scripts",
		"--min-release-age=0",
		"@earendil-works/pi-coding-agent@9.9.9",
	]) {
		assert.ok(selfArgs.includes(expectedArg), `self-update dispatch should include ${expectedArg}`);
	}

	const extensionHome = join(sandbox, "extension-home");
	const extensionCwd = join(sandbox, "extension-cwd");
	const extensionAgentDir = join(extensionHome, ".pi", "agent");
	const extensionPrefix = join(sandbox, "extension-prefix");
	const extensionRecordPath = join(sandbox, "extension-invocations.jsonl");
	await Promise.all([
		mkdir(extensionAgentDir, { recursive: true }),
		mkdir(extensionCwd, { recursive: true }),
	]);
	await writeFile(
		join(extensionAgentDir, "settings.json"),
		JSON.stringify({
			npmCommand: [process.execPath, shimPath],
			packages: ["npm:pi-xai-oauth"],
		}),
		"utf8",
	);
	await runCli(cliPath, ["update", "npm:pi-xai-oauth"], {
		cwd: extensionCwd,
		env: isolatedEnv({
			agentDir: extensionAgentDir,
			home: extensionHome,
			prefix: extensionPrefix,
			preloadPath,
			recordPath: extensionRecordPath,
		}),
	});
	const extensionInvocations = await readInvocations(extensionRecordPath);
	assert.deepEqual(
		extensionInvocations,
		[[
			"install",
			"pi-xai-oauth@latest",
			"--prefix",
			join(extensionAgentDir, "npm"),
			"--legacy-peer-deps",
		]],
		"targeted pi update should dispatch the configured extension install",
	);
	const installedExtension = JSON.parse(
		await readFile(
			join(extensionAgentDir, "npm", "node_modules", "pi-xai-oauth", "package.json"),
			"utf8",
		),
	);
	assert.equal(installedExtension.name, "pi-xai-oauth");
	assert.equal(installedExtension.version, "9.9.9");

	console.log(`verify-pi-cli: ok (Pi ${expectedVersion}; isolated update dispatch)`);
} finally {
	await rm(sandbox, { recursive: true, force: true });
}
