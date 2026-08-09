import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  GITHUB_PACKAGE_NAME,
  GITHUB_REGISTRY,
  rewritePackageManifest,
} = require("../../scripts/prepare-github-package.js") as {
  GITHUB_PACKAGE_NAME: string;
  GITHUB_REGISTRY: string;
  rewritePackageManifest(manifest: Record<string, any>): Record<string, any>;
};

function sourceManifest(overrides: Record<string, any> = {}) {
  return {
    name: "pi-xai-oauth",
    version: "1.4.2",
    repository: {
      type: "git",
      url: "git+https://github.com/BlockedPath/pi-xai-oauth.git",
    },
    publishConfig: { provenance: true },
    peerDependencies: {
      "@earendil-works/pi-ai": ">=0.80.1 <0.85.0",
    },
    ...overrides,
  };
}

describe("GitHub Packages mirror manifest", () => {
  it("rewrites only the distribution identity and registry", () => {
    const source = sourceManifest();
    const mirrored = rewritePackageManifest(source);

    expect(mirrored).toMatchObject({
      name: GITHUB_PACKAGE_NAME,
      version: "1.4.2",
      repository: source.repository,
      peerDependencies: source.peerDependencies,
      publishConfig: {
        provenance: true,
        registry: GITHUB_REGISTRY,
      },
    });
    expect(source).toMatchObject({
      name: "pi-xai-oauth",
      publishConfig: { provenance: true },
    });
  });

  it("rejects unexpected source package and repository identities", () => {
    expect(() => rewritePackageManifest(sourceManifest({ name: "other-package" })))
      .toThrow(/Expected source package pi-xai-oauth/);
    expect(() => rewritePackageManifest(sourceManifest({
      repository: { url: "https://github.com/example/fork.git" },
    }))).toThrow(/Expected repository/);
  });
});
