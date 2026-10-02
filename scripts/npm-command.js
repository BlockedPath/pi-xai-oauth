"use strict";

const fs = require("fs");
const path = require("path");

function npmCli(candidate) {
  try {
    if (!path.isAbsolute(candidate)) return undefined;
    const resolved = fs.realpathSync(candidate);
    if (path.basename(resolved) !== "npm-cli.js" || !fs.statSync(resolved).isFile()) return undefined;
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), "..", "package.json"), "utf8"));
    return manifest.name === "npm" ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve npm's JavaScript CLI without executing platform-specific shell wrappers. */
function resolveNpmCli({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const candidates = [];
  if (typeof env.npm_execpath === "string") candidates.push(env.npm_execpath);
  const nodeDirectory = path.dirname(execPath);
  candidates.push(
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDirectory, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
  );
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  for (const entry of (env[pathKey] || "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    const directory = path.resolve(entry);
    candidates.push(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
    for (const command of platform === "win32" ? ["npm.cmd", "npm"] : ["npm"]) {
      candidates.push(path.join(directory, command));
    }
  }
  for (const candidate of candidates) {
    const resolved = npmCli(candidate);
    if (resolved) return resolved;
  }
  throw new Error("Could not resolve npm-cli.js from npm_execpath, the Node installation, or PATH; install npm alongside Node or provide a valid npm_execpath");
}

/** Preserve npm arguments as an array and run its CLI with the current Node executable. */
function npmCommand(args, options = {}) {
  return { command: process.execPath, args: [resolveNpmCli(options), ...args] };
}

module.exports = { npmCommand, resolveNpmCli };
