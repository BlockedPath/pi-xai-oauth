import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    isolate: true,
    fileParallelism: false,
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: process.env.GITHUB_ACTIONS
      ? ["default", "github-actions"]
      : ["default"],
    coverage: {
      provider: "v8",
      include: ["extensions/**/*.ts"],
      exclude: ["extensions/xai/constants.ts"],
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        statements: 86,
        branches: 80,
        functions: 87,
        lines: 90,
      },
    },
  },
});
