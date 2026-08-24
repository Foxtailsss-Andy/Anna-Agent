import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(packageRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

test("keeps Pi and tool imports confined to the loop kernel", () => {
  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const sourcePath = relative(packageRoot, file);
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);

    for (const specifier of imports) {
      if (specifier.startsWith("@earendil-works/pi-")) {
        expect(sourcePath).toBe("src/pi-loop-kernel.ts");
      }
      expect(specifier).not.toMatch(/@earendil-works\/pi-(?:coding-agent|agent-core\/harness)(?:\/|$)/);
      expect(specifier).not.toMatch(/(?:^|\/)(?:file|bash|shell|network)(?:\/|$)/);
    }

    expect(source).not.toMatch(/\b(?:CodingAgentHarness|AgentHarness)\b/);
    expect(source).not.toMatch(/\b(?:File|Bash|Shell|Network)Tool\b/);
  }
});

test("pins the two direct Pi dependencies to 0.84.2", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  expect(manifest.dependencies["@earendil-works/pi-agent-core"]).toBe("0.84.2");
  expect(manifest.dependencies["@earendil-works/pi-ai"]).toBe("0.84.2");
});
