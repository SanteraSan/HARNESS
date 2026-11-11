import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/helpers/db.ts"],
    fileParallelism: false,
    isolate: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      all: true,
      provider: "v8",
      reporter: ["lcovonly"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
    },
  },
});
