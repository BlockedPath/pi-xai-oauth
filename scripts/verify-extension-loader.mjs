#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const previousHome = process.env.HOME;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const home = await mkdtemp(join(tmpdir(), "pi-xai-loader-"));
try {
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	const packageMain = fileURLToPath(
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	);
	const loaderUrl = pathToFileURL(
		join(dirname(packageMain), "core", "extensions", "loader.js"),
	).href;
	const { createExtensionRuntime, loadExtensions } = await import(loaderUrl);
	const runtime = createExtensionRuntime();
	const result = await loadExtensions(
		[join(repoRoot, "extensions", "xai-oauth.ts")],
		repoRoot,
		undefined,
		runtime,
	);
	assert.deepEqual(
		result.errors,
		[],
		"real Pi loader should load the extension without errors",
	);
	assert.equal(
		result.extensions.length,
		1,
		"real Pi loader should load exactly one extension",
	);
	const loaded = result.extensions[0];
	assert.ok(
		loaded.tools.has("xai_generate_text"),
		"representative xAI tool should be registered",
	);
	assert.ok(
		loaded.tools.has("xai_edit_image"),
		"bounded xAI image-edit tool should be registered",
	);
	assert.ok(
		loaded.tools.has("xai_image_to_video"),
		"bounded xAI image-to-video tool should be registered",
	);
	assert.ok(
		loaded.tools.has("xai_grok_grep"),
		"collision-free Grok grep dispatcher should be registered",
	);
	assert.ok(
		!loaded.tools.has("grep"),
		"public Grok tool names must remain collision-free",
	);
	assert.ok(
		loaded.tools.has("xai_grok_web_search"),
		"collision-free Grok web-search dispatcher should be registered",
	);
	assert.ok(
		!loaded.tools.has("xai_web_search"),
		"legacy xAI web-search wrapper should not be registered alongside the Grok dispatcher",
	);
	assert.ok(
		!loaded.tools.has("web_search"),
		"public Grok web-search name must remain free for other extensions",
	);
	assert.ok(
		loaded.commands.has("xai-tools"),
		"/xai-tools should be registered",
	);
	assert.ok(
		loaded.commands.has("xai-usage"),
		"/xai-usage should be registered",
	);
	assert.equal(
		runtime.pendingProviderRegistrations.length,
		1,
		"one provider should be queued",
	);
	const provider = runtime.pendingProviderRegistrations[0];
	assert.equal(provider.name, "xai-auth");
	assert.equal(provider.config.api, "xai-responses");
	assert.equal(provider.config.baseUrl, "https://cli-chat-proxy.grok.com/v1");
	const modelIds = provider.config.models.map((model) => model.id);
	assert.deepEqual(
		modelIds.slice(0, 1),
		["grok-4.6"],
		"curated fallback canonical should lead the advertised list",
	);
	// Offline fallback is exact to the curated default only. Grok 4.5 aliases and
	// the grok-4.3 compatibility route appear only when their entitlement source
	// is present in an authenticated catalog snapshot.
	assert.equal(
		modelIds.includes("grok-composer-2.5-fast"),
		false,
		"composer alias must not invent entitlement from grok-4.6 fallback alone",
	);
	assert.equal(modelIds.includes("grok-4.5-latest"), false);
	assert.equal(modelIds.includes("grok-4.3"), false);
	assert.deepEqual(
		modelIds,
		["grok-4.6"],
		"fallback should advertise only the curated default model",
	);
	console.log("verify-extension-loader: ok");
} finally {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(home, { recursive: true, force: true });
}
