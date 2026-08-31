import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { defineConfig } from "vite";
import { measureOmpImplementation } from "../../packages/omp-loop-kernel/src/kernel-source";
import {
  createPiKernelSourceIdentitySync,
} from "../../packages/pi-loop-kernel/src/kernel-source";

const root = resolve(import.meta.dirname);
const ompImplementation = measureOmpImplementation(resolve(root, "../../packages/omp-loop-kernel"));
const piSourceIdentity = createPiKernelSourceIdentitySync(
  resolve(root, "../../packages/pi-loop-kernel/src"),
);

export default defineConfig({
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __ANNA_PI_KERNEL_SOURCE_SHA256__: JSON.stringify(piSourceIdentity.sha256),
    __ANNA_OMP_IMPLEMENTATION__: JSON.stringify(ompImplementation),
  },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: false,
    ssr: resolve(root, "src/preview-main.ts"),
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
  },
  ssr: {
    noExternal: true,
  },
});
