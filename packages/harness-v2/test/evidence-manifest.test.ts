import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createEvidenceManifest } from "../src/index";

test("creates a sorted evidence manifest with reproducible file hashes", async () => {
  const root = await mkdtemp(join("/tmp", "anna-evidence-"));
  try {
    await writeFile(join(root, "ground-truth.json"), '{"answer":"ready"}\n');
    await writeFile(join(root, "prompt.json"), '{"message":"run"}\n');

    const manifest = await createEvidenceManifest(root, {
      caseId: "t07-live-001",
      generatedAt: "2026-08-22T00:00:00.000Z",
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "ground-truth.json",
      "prompt.json",
    ]);
    expect(manifest.files[0]).toMatchObject({
      path: "ground-truth.json",
      size: 19,
      sha256: createHash("sha256").update('{"answer":"ready"}\n').digest("hex"),
    });
    expect(await readFile(join(root, manifest.files[1].path), "utf8")).toBe(
      '{"message":"run"}\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not include an existing manifest in its own file list", async () => {
  const root = await mkdtemp(join("/tmp", "anna-evidence-"));
  try {
    await writeFile(join(root, "manifest.json"), "old\n");
    await writeFile(join(root, "trace.json"), "{}\n");

    const manifest = await createEvidenceManifest(root, {
      caseId: "fixture-001",
      generatedAt: "2026-08-22T00:00:00.000Z",
    });

    expect(manifest.files.map((file) => file.path)).toEqual(["trace.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
