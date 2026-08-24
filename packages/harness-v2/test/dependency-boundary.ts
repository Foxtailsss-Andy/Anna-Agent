import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const importPathPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s]+?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const forbiddenImportPatterns = [
  /(^|\/)(?:pi-agent-core|pi-ai)(?:\/|$)/i,
  /(^|\/)electron(?:\/|$)/i,
  /(^|\/)(?:crew|legacy|services)(?:\/|$)/i,
  /\.py$/i,
  /sqlite/i,
];

const sourceExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : sourceExtensions.some((extension) => path.endsWith(extension))
        ? [path]
        : [];
  });
}

export function assertContractsDependencyBoundary(sourceRoot: string): void {
  for (const path of sourceFiles(sourceRoot)) {
    const source = readFileSync(path, "utf8");

    for (const match of source.matchAll(importPathPattern)) {
      const importPath = match[1] ?? match[2];
      if (forbiddenImportPatterns.some((pattern) => pattern.test(importPath))) {
        throw new Error(`forbidden contract dependency in ${path}: ${importPath}`);
      }
    }
  }
}
