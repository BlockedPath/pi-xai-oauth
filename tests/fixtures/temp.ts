import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** Create a unique owned temporary directory and cleanup callback. */
export async function createTempDir(prefix = "pi-xai-test-") {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Point both Unix and Windows home resolution at an owned test directory. */
export function stubHome(path: string): void {
  vi.stubEnv("HOME", path);
  vi.stubEnv("USERPROFILE", path);
}
