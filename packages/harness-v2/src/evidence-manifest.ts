import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface EvidenceManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface EvidenceManifestOptions {
  readonly caseId: string;
  readonly generatedAt: string;
  readonly metadata?: Readonly<Record<string, boolean | number | string | null>>;
}

export interface EvidenceManifest {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly generatedAt: string;
  readonly files: readonly EvidenceManifestFile[];
  readonly metadata?: Readonly<Record<string, boolean | number | string | null>>;
}

async function listFiles(root: string, current: string, result: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).split(sep).join("/");
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Evidence manifest rejects symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await listFiles(root, path, result);
    } else if (stats.isFile() && relativePath !== "manifest.json") {
      result.push(relativePath);
    }
  }
}

export async function createEvidenceManifest(
  root: string,
  options: EvidenceManifestOptions,
): Promise<EvidenceManifest> {
  if (options.caseId.trim().length === 0) {
    throw new Error("Evidence manifest caseId must be non-empty");
  }
  if (Number.isNaN(Date.parse(options.generatedAt))) {
    throw new Error("Evidence manifest generatedAt must be a timestamp");
  }

  const paths: string[] = [];
  await listFiles(root, root, paths);
  const files = await Promise.all(paths.sort().map(async (path) => {
    const bytes = await readFile(join(root, path));
    return {
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    } satisfies EvidenceManifestFile;
  }));

  return {
    schemaVersion: 1,
    caseId: options.caseId,
    generatedAt: options.generatedAt,
    files,
    ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
  };
}
