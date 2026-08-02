import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["wjs/**", "node_modules/**", "dist/**"],
    // Integration files mutate process-global state. Fork isolation keeps those
    // mutations local to one file while still allowing file-level parallelism.
    pool: "forks",
    fileParallelism: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage"
    }
  }
});
