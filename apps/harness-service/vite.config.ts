import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { defineConfig } from "vite";
import {
  assertPiKernelSourceIdentity,
  createPiKernelSourceIdentitySync,
  PI_KERNEL_UPSTREAM,
} from "../../packages/pi-loop-kernel/src/kernel-source.ts";

const root = resolve(import.meta.dirname);
const buildSourceIdentity = createPiKernelSourceIdentitySync(
  resolve(root, "../../packages/pi-loop-kernel/src"),
);

export default defineConfig({
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __ANNA_PI_KERNEL_SOURCE_SHA256__: JSON.stringify(buildSourceIdentity.sha256),
  },
  plugins: [piKernelDescriptorSidecar()],
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
    noExternal: true,
  },
});

function piKernelDescriptorSidecar() {
  return {
    name: "anna-pi-kernel-descriptor-sidecar",
    async generateBundle(this: { emitFile: (file: {
      type: "asset";
      fileName: string;
      source: string;
    }) => void }) {
      const descriptor = await createBuildPiKernelDescriptor();
      this.emitFile({
        type: "asset",
        fileName: "pi-kernel-descriptor.json",
        source: JSON.stringify(descriptor) + "\n",
      });
    },
  };
}

async function createBuildPiKernelDescriptor() {
  await verifyBuildUpstreamIdentity();
  assertPiKernelSourceIdentity(
    buildSourceIdentity,
    createPiKernelSourceIdentitySync(resolve(root, "../../packages/pi-loop-kernel/src")),
  );
  return {
    schemaVersion: 1,
    adapterId: "pi",
    protocolVersion: "anna-loop-kernel/1",
    adapterSource: {
      packageName: "@anna/pi-loop-kernel",
      sha256: buildSourceIdentity.sha256,
    },
    upstream: PI_KERNEL_UPSTREAM,
  };
}

async function verifyBuildUpstreamIdentity(): Promise<void> {
  const rootDirectory = resolve(root, "../..");
  const expected = [
    {
      name: "@earendil-works/pi-agent-core",
      version: "0.84.2",
      integrity: "sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA==",
    },
    {
      name: "@earendil-works/pi-ai",
      version: "0.84.2",
      integrity: "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
    },
  ] as const;
  const lock = JSON.parse(await readFile(resolve(rootDirectory, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: unknown; integrity?: unknown }>;
  };
  for (const packageIdentity of expected) {
    const packageJson = JSON.parse(await readFile(
      resolve(rootDirectory, "node_modules", packageIdentity.name, "package.json"),
      "utf8",
    )) as { version?: unknown };
    const lockEntry = lock.packages?.[`node_modules/${packageIdentity.name}`];
    if (
      packageJson.version !== packageIdentity.version
      || lockEntry?.version !== packageIdentity.version
      || lockEntry.integrity !== packageIdentity.integrity
    ) {
      throw new Error(`${packageIdentity.name} Pi upstream identity verification failed`);
    }
  }
}
