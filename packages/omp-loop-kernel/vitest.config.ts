import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    cache: false,
    environment: "node",
    // SDK fixtures copy the pinned runtime; bound filesystem contention.
    maxWorkers: 2,
    include: ["test/**/*.test.ts"],
  },
});
