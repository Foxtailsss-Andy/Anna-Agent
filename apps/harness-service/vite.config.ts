import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { defineConfig } from "vite";

const root = resolve(import.meta.dirname);

export default defineConfig({
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    ssr: resolve(root, "src/main.ts"),
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
  },
  ssr: {
    noExternal: [/^@anna\//, /^@earendil-works\//],
  },
});
