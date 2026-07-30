#!/usr/bin/env node

/**
 * pi-xai-oauth — One-command installer for xAI tools/usage + optional OAuth catalog
 * Enhanced with --scaffold support for 2026 agent best practices
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PACKAGE_NAME = "pi-xai-oauth";
const NPM_SPEC = `npm:${PACKAGE_NAME}`;
/** Pi's built-in SuperGrok/X Premium provider used for normal chat. */
const BUNDLED_XAI_PROVIDER = "xai";
/** Package-owned OAuth catalog/stream provider (optional). */
const PACKAGE_OAUTH_PROVIDER = "xai-auth";
const DEFAULT_XAI_MODEL = "grok-4.5";
const DEFAULT_THINKING_LEVEL = "high";
const SETTINGS_PATH = path.join(os.homedir(), ".pi/agent/settings.json");

// ANSI colors
const colors = {
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function color(text, c) {
  return `${colors[c] || ""}${text}${colors.reset}`;
}

function printHeader() {
  console.log(`\n${color("🚀  pi-xai-oauth", "cyan")} — ${color("xAI tools + usage for pi", "bold")}\n`);
  console.log("   Installs opt-in xAI tools and /xai-usage alongside Pi's built-in xAI chat.");
  console.log(`   Optional package-owned catalog/stream remains available as ${PACKAGE_OAUTH_PROVIDER}.\n`);
}

function checkPi() {
  try {
    execSync("which pi", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function installPackage() {
  console.log(color("📦 Installing pi-xai-oauth into pi...", "cyan"));
  try {
    execSync(`pi install ${NPM_SPEC}`, { stdio: "inherit" });
    console.log(color("\n✅ Package installed successfully!", "green"));
    return true;
  } catch (err) {
    console.error(color(`\n❌ Failed to run 'pi install': ${err && err.message ? err.message : err}`, "red"));
    console.log(`Please run manually:  ${color(`pi install ${NPM_SPEC}`, "yellow")}`);
    return false;
  }
}

function getPackageEntrySource(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
  return undefined;
}

function getNpmPackageName(source) {
  if (typeof source !== "string" || !source.startsWith("npm:")) return undefined;
  const spec = source.slice("npm:".length);
  if (spec.startsWith("@")) {
    const slashIndex = spec.indexOf("/");
    if (slashIndex === -1) return spec;
    const versionIndex = spec.indexOf("@", slashIndex + 1);
    return versionIndex === -1 ? spec : spec.slice(0, versionIndex);
  }
  const versionIndex = spec.indexOf("@");
  return versionIndex === -1 ? spec : spec.slice(0, versionIndex);
}

function resolveLocalPackageJson(source, settingsPath = SETTINGS_PATH) {
  if (typeof source !== "string") return undefined;
  if (source.startsWith("npm:") || source.startsWith("git:") || /^[a-z]+:\/\//i.test(source)) return undefined;

  const expanded = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
  const resolved = path.resolve(path.dirname(settingsPath), expanded);

  try {
    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? path.join(resolved, "package.json") : path.join(path.dirname(resolved), "package.json");
  } catch {
    return undefined;
  }
}

function isLocalPackageNamed(source, packageName = PACKAGE_NAME, settingsPath = SETTINGS_PATH) {
  const packageJsonPath = resolveLocalPackageJson(source, settingsPath);
  if (!packageJsonPath) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return pkg.name === packageName;
  } catch {
    return false;
  }
}

function pruneDuplicatePackageEntries(packages, settingsPath = SETTINGS_PATH, packageName = PACKAGE_NAME) {
  let hasNpmPackage = false;
  const removed = [];
  const next = [];

  for (const entry of packages) {
    const source = getPackageEntrySource(entry);
    if (getNpmPackageName(source) === packageName) {
      hasNpmPackage = true;
      next.push(entry);
      continue;
    }

    if (isLocalPackageNamed(source, packageName, settingsPath)) {
      removed.push(source);
      continue;
    }

    next.push(entry);
  }

  if (!hasNpmPackage) {
    next.push(NPM_SPEC);
    hasNpmPackage = true;
  }

  return { packages: next, removed, addedNpmPackage: !packages.some((entry) => getNpmPackageName(getPackageEntrySource(entry)) === packageName) };
}

function updateSettings(settingsPath = SETTINGS_PATH) {
  console.log(color("\n⚙️  Configuring pi settings...", "cyan"));

  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (e) {
      const backupPath = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        fs.copyFileSync(settingsPath, backupPath);
        console.log(color(`   Warning: Could not parse existing settings.json (${e.message}); backed it up to ${backupPath}`, "yellow"));
      } catch (backupError) {
        console.error(color(`   ❌ Could not parse existing settings.json (${e.message}) and could not back it up (${backupError.message}).`, "red"));
        console.log(`   Fix or move ${settingsPath} and re-run, or configure pi manually.\n`);
        return false;
      }
    }
  }

  let changed = false;

  if (!Array.isArray(settings.packages)) {
    settings.packages = [];
  }

  const packagePrune = pruneDuplicatePackageEntries(settings.packages, settingsPath);
  if (packagePrune.removed.length > 0) {
    settings.packages = packagePrune.packages;
    changed = true;
    for (const source of packagePrune.removed) {
      console.log(color(`   - Removed duplicate local ${PACKAGE_NAME} package: ${source}`, "yellow"));
    }
  }

  if (packagePrune.addedNpmPackage) {
    settings.packages = packagePrune.packages;
    changed = true;
    console.log(color(`   + Added ${NPM_SPEC} to packages`, "green"));
  }

  // Prefer Pi's built-in xAI chat when no provider is configured. Never overwrite
  // an existing choice — including package-owned xai-auth or any other provider.
  const hadProvider = typeof settings.defaultProvider === "string" && settings.defaultProvider.trim() !== "";
  if (!hadProvider) {
    settings.defaultProvider = BUNDLED_XAI_PROVIDER;
    changed = true;
    console.log(color(`   + Set defaultProvider: ${BUNDLED_XAI_PROVIDER}`, "green"));
  } else if (settings.defaultProvider === PACKAGE_OAUTH_PROVIDER) {
    console.log(color(`   (Keeping defaultProvider: ${PACKAGE_OAUTH_PROVIDER})`, "reset"));
  }

  // The model/thinking defaults are only coherent alongside an xAI provider.
  // Seeding them next to an unrelated provider (e.g. anthropic) would leave the
  // user on an impossible provider/model pair, so scope the writes:
  //   - provider newly seeded here  -> this package owns the whole selection
  //   - existing xAI provider       -> only fill in blanks, never replace a choice
  //   - existing non-xAI provider   -> leave the selection untouched
  const usesXaiProvider =
    settings.defaultProvider === BUNDLED_XAI_PROVIDER ||
    settings.defaultProvider === PACKAGE_OAUTH_PROVIDER;
  const ownsModelSelection = !hadProvider;

  if (ownsModelSelection || usesXaiProvider) {
    const blank = (value) => typeof value !== "string" || value.trim() === "";

    if ((ownsModelSelection || blank(settings.defaultModel)) && settings.defaultModel !== DEFAULT_XAI_MODEL) {
      settings.defaultModel = DEFAULT_XAI_MODEL;
      changed = true;
      console.log(color(`   + Set defaultModel: ${DEFAULT_XAI_MODEL}`, "green"));
    }

    if (
      (ownsModelSelection || blank(settings.defaultThinkingLevel)) &&
      settings.defaultThinkingLevel !== DEFAULT_THINKING_LEVEL
    ) {
      settings.defaultThinkingLevel = DEFAULT_THINKING_LEVEL;
      changed = true;
      console.log(color(`   + Set defaultThinkingLevel: ${DEFAULT_THINKING_LEVEL}`, "green"));
    }
  }

  if (changed) {
    try {
      const dir = path.dirname(settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(color("   ✅ Settings updated!", "green"));
    } catch (e) {
      console.error(color(`   ❌ Could not write settings.json: ${e.message}`, "red"));
      console.log(`   Configure ${settingsPath} manually and re-run if needed.\n`);
      return false;
    }
  } else {
    console.log(color("   (Settings already configured)", "reset"));
  }
  return true;
}

function printNextSteps(nonInteractive = false) {
  console.log(`\n${color("🎉  Setup complete!", "green")}\n`);

  if (!nonInteractive) {
    console.log("Next steps:\n");
    console.log(`   ${color("1.", "bold")} Authenticate for chat (Pi built-in xAI):`);
    console.log(`      ${color("pi", "cyan")}`);
    console.log("      Then run /login xai\n");
    console.log(`   ${color("2.", "bold")} Optional package-owned OAuth catalog/stream:`);
    console.log("      Run /login xai-auth only if you want this package's Responses catalog.");
    console.log("      Prefer browser (default) or device code.\n");
    console.log(`   ${color("3.", "bold")} Use package tools and subscription usage on either provider:`);
    console.log("      /xai-tools   — opt-in network tools (web/X search, images, etc.)");
    console.log("      /xai-usage   — SuperGrok subscription usage\n");
    console.log(`   ${color("4.", "bold")} Start chatting with Grok 4.5 (default model)`);
    console.log(`      ${color("pi", "cyan")}\n`);
  } else {
    console.log("Package tools and /xai-usage are installed. Chat defaults to Pi's built-in xAI provider when unset.\n");
  }

  console.log("You now have access to powerful reasoning, coding models, and long context!\n");
  console.log("Bonus tools available:");
  console.log("   • xai_generate_text     — Generate text with full reasoning");
  console.log("   • xai_multi_agent       — Multi-agent research with web/X tools");
  console.log("   • web_search            — Native xAI web search");
  console.log("   • xai_x_search          — Native X/Twitter search");
  console.log("   • xai_code_execution    — Native code interpreter");
  console.log("   • xai_generate_image    — Image generation");
  console.log("   • xai_edit_image        — Bounded local PNG/JPEG image editing");
  console.log("   • xai_analyze_image     — Image analysis");
  console.log("   • xai_critique          — Structured critique");
  console.log("   • xai_deep_research     — Deep research with web/X tools\n");
  console.log(`   Update later: ${color("pi update npm:pi-xai-oauth", "yellow")}\n`);
}

function printScaffoldHeader() {
  console.log(`\n${color("🛠️  Agent Scaffolding", "cyan")} — ${color("2026 best practices for pi agents", "bold")}\n`);
  console.log("   Bootstraps AGENTS.md + .scaffold/ persistent state harness for reliable multi-agent work.\n");
}

function generateScaffold(nonInteractive = false) {
  printScaffoldHeader();
  console.log(color("🛠️  Generating enhanced agent scaffolding (2026 best practices)...", "cyan"));

  const scaffoldDir = path.join(process.cwd(), ".scaffold");
  const date = new Date().toISOString().split("T")[0];
  let branch = "feature/your-task";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { stdio: "pipe", encoding: "utf8" }).trim();
  } catch {}
  let projectName = "pi-package";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    if (pkg.name) projectName = pkg.name;
  } catch {}
  // projectName and branch now dynamic

  const templates = {
    "plan.md": `# Implementation Plan: Enhanced Agent Scaffolding

**Project:** ${projectName}
**Branch:** ${branch}
**Date:** ${date}

## Phase 1: Foundation
- [ ] Run setup with --scaffold
- [ ] Customize this plan

## Phase 2: Persistent State
- [ ] Review constraints.md
- [ ] Update progress.md after each step

## Next
Use parallel subagents and keep this plan updated.

This harness follows 2026 best practices for reliable agentic work.`,
    
    "constraints.md": `# Constraints & Safety Rules

## Hard Boundaries (MUST NOT)
- Never commit API keys, tokens, or secrets
- Never skip feature branches
- Never ignore subagent failures or tool errors

## MUST
- Always read AGENTS.md before starting work
- Update .scaffold/progress.md after every significant step
- Prefer PARALLEL subagent mode for independent tasks
- Use external state files for long-running work

## Tool Rules
- Specify cwd when relevant
- Run reviewer before final merges
- Keep context lean with vertical slices where possible`,
    
    "progress.md": `# Execution Progress

**Project:** ${projectName}
**Branch:** ${branch}
**Started:** ${date}

## Completed
- [x] Created new branch
- [x] Parallel agent research + recon
- [x] Generated AGENTS.md
- [x] Generated .scaffold/ persistent state files
- [x] Enhanced bin/setup.js with --scaffold support

## In Progress
- [ ] Customize templates for this project
- [ ] Implement additional phases from plan.md

## Next
Run \`node bin/setup.js --scaffold\` in new projects to bootstrap this harness.

Update this file frequently.`,

    "context.md": `# Shared Agent Context

**Project:** ${projectName}
**Branch:** ${branch}
**Date:** ${date}

## Key Context
- This project provides xAI OAuth + Grok 4.5 for pi agents.
- Use subagent tool for delegation.
- Persistent state lives in .scaffold/.

## Current Focus
See plan.md for active phases.

Update as work progresses.`
  };

  try {
    if (!fs.existsSync(scaffoldDir)) {
      fs.mkdirSync(scaffoldDir, { recursive: true });
      console.log(color("   + Created .scaffold/ directory", "green"));
    }

    Object.entries(templates).forEach(([filename, content]) => {
      const filePath = path.join(scaffoldDir, filename);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, content, "utf8");
        console.log(color(`   + Generated ${filename}`, "green"));
      } else {
        console.log(color(`   (Skipped existing ${filename})`, "yellow"));
      }
    });

    // Generate basic AGENTS.md if missing
    const agentsPath = path.join(process.cwd(), "AGENTS.md");
    if (!fs.existsSync(agentsPath)) {
      const basicAgents = `# AGENTS.md — AI Agent Operations Manual

> For AI coding agents. Human docs in README.md.

## Project
pi-xai-oauth — xAI OAuth provider for pi framework.

## Commands
- Scaffold: node bin/setup.js --scaffold
- Install: pi install npm:pi-xai-oauth

## Workflow
- Always use feature branches
- Use subagent with PARALLEL for research/planning
- Track everything in .scaffold/

See .scaffold/plan.md for current roadmap.`;
      fs.writeFileSync(agentsPath, basicAgents, "utf8");
      console.log(color("   + Generated AGENTS.md", "green"));
    }

    console.log(color("\n✅ Scaffolding generation complete!", "green"));
    console.log("   Ready for multi-agent workflows with persistent state.\n");

    if (!nonInteractive) {
      console.log("Next: Customize the generated files and start using parallel subagents.\n");
    }
  } catch (err) {
    console.error(color("\n❌ Scaffolding generation failed:", "red"), err.message);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`\n${color("pi-xai-oauth", "cyan")} — CLI for xAI tools/usage setup and agent scaffolding\n`);
  console.log("Usage:");
  console.log("  npx pi-xai-oauth              Install package + seed native xAI chat defaults when unset");
  console.log("  npx pi-xai-oauth --scaffold   Generate .scaffold/ harness in current project");
  console.log("  npx pi-xai-oauth --yes        Non-interactive / automated mode");
  console.log("  npx pi-xai-oauth --help       Show this help\n");
  console.log("Examples:");
  console.log("  npx pi-xai-oauth --scaffold   # in any pi project to add agent harness\n");
}

function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes") || args.includes("-y");
  const scaffold = args.includes("--scaffold") || args.includes("-s");
  const help = args.includes("--help") || args.includes("-h");

  if (help) {
    printHelp();
    return;
  }

  if (scaffold) {
    generateScaffold(yes);
    return;
  }

  printHeader();

  if (!checkPi()) {
    console.log(color("❌ 'pi' command not found in PATH.", "red"));
    console.log("Please install pi first → https://pi.dev\n");
    process.exit(1);
  }

  if (!installPackage()) {
    process.exit(1);
  }

  if (!updateSettings()) {
    process.exit(1);
  }

  printNextSteps(yes);
}

if (require.main === module) {
  main();
}

module.exports = {
  PACKAGE_NAME,
  NPM_SPEC,
  getNpmPackageName,
  isLocalPackageNamed,
  pruneDuplicatePackageEntries,
  updateSettings,
};
