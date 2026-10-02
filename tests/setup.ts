import { afterEach, beforeEach, vi } from "vitest";
import { createTempDir, stubHome } from "./fixtures/temp";

let home: Awaited<ReturnType<typeof createTempDir>>;

beforeEach(async () => {
  home = await createTempDir("pi-xai-home-");
  stubHome(home.path);
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await home.cleanup();
});
