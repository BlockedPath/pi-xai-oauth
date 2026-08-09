#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SOURCE_PACKAGE_NAME = "pi-xai-oauth";
const GITHUB_PACKAGE_NAME = "@blockedpath/pi-xai-oauth";
const GITHUB_REGISTRY = "https://npm.pkg.github.com";
const REPOSITORY_URL = "git+https://github.com/BlockedPath/pi-xai-oauth.git";

function rewritePackageManifest(manifest) {
  if (manifest?.name !== SOURCE_PACKAGE_NAME) {
    throw new Error(`Expected source package ${SOURCE_PACKAGE_NAME}, received ${manifest?.name ?? "missing name"}`);
  }
  const repositoryUrl = typeof manifest.repository === "string"
    ? manifest.repository
    : manifest.repository?.url;
  if (repositoryUrl !== REPOSITORY_URL) {
    throw new Error(`Expected repository ${REPOSITORY_URL}, received ${repositoryUrl ?? "missing repository"}`);
  }

  return {
    ...manifest,
    name: GITHUB_PACKAGE_NAME,
    publishConfig: {
      ...manifest.publishConfig,
      registry: GITHUB_REGISTRY,
    },
  };
}

function prepareGithubPackage(sourceTarball, destination) {
  const tarballPath = path.resolve(sourceTarball);
  const outputRoot = path.resolve(destination);
  const packageDirectory = path.join(outputRoot, "package");
  const tarballStat = fs.statSync(tarballPath);
  if (!tarballStat.isFile()) {
    throw new Error(`Canonical package tarball is not a regular file: ${tarballPath}`);
  }
  if (fs.existsSync(packageDirectory)) {
    throw new Error(`Refusing to overwrite prepared package directory: ${packageDirectory}`);
  }

  fs.mkdirSync(outputRoot, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", outputRoot], { stdio: "inherit" });

  const manifestPath = path.join(packageDirectory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rewritten = rewritePackageManifest(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
  return packageDirectory;
}

if (require.main === module) {
  const [sourceTarball, destination] = process.argv.slice(2);
  if (!sourceTarball || !destination) {
    console.error("Usage: node scripts/prepare-github-package.js <canonical-tarball> <output-directory>");
    process.exit(1);
  }
  console.log(prepareGithubPackage(sourceTarball, destination));
}

module.exports = {
  GITHUB_PACKAGE_NAME,
  GITHUB_REGISTRY,
  SOURCE_PACKAGE_NAME,
  prepareGithubPackage,
  rewritePackageManifest,
};
