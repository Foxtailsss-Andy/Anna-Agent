import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    cache: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
