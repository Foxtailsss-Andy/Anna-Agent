import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const forbiddenImports = [
  /(?:^|\/)@earendil-works\/pi(?:-|\/|$)|(?:^|\/)pi-(?:ai|agent)/i,
  /^electron(?:\/|$)/i,
  /(?:^|\/)(?:services\/(?:runtime|chat)|[^/]+\.py)(?:\/|$)/i,
  /(?:^|\/)crew(?:\/|$)/i,
  /sqlite/i,
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );

  return nested.flat();
}

describe("Harness service architecture", () => {
  test("does not import Pi, Electron, legacy Python, Crew, or SQLite", async () => {
    const imports = await Promise.all(
      (await sourceFiles(sourceDirectory)).map(async (path) => {
        const contents = await readFile(path, "utf8");
        return [
          ...contents.matchAll(
            /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g,
          ),
        ].map(([, specifier]) => specifier);
      }),
    );

    const forbidden = imports
      .flat()
      .filter((specifier) => forbiddenImports.some((pattern) => pattern.test(specifier)));

    expect(forbidden).toEqual([]);
  });
});
