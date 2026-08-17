import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const finderArtifact = path.join(repoRoot, "tests", ".DS_Store");
const hasGitMetadata = existsSync(path.join(repoRoot, ".git"));

describe.runIf(hasGitMetadata)("compatibility pack verifier", () => {
  it("ignores a gitignored Finder artifact", () => {
    const existedBefore = existsSync(finderArtifact);
    if (!existedBefore) writeFileSync(finderArtifact, "ignored Finder artifact");

    try {
      const result = spawnSync(process.execPath, ["scripts/verify-compatibility.js", "pack"], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      const output = `${result.stdout || ""}${result.stderr || ""}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain("packed manifest:");
    } finally {
      if (!existedBefore) unlinkSync(finderArtifact);
    }
  });
});
