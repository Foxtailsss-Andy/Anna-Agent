import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  lstat,
  rename,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const runtimePackageRoot = resolve(repositoryRoot, "packages/omp-loop-kernel/runtime");
const runtimeOutputRoot = resolve(repositoryRoot, "build/omp-runtime/darwin-arm64");
const bunVersion = "1.3.14";
const bunArchiveSha256 = "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620";
const bunBinarySha256 = "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233";
const runtimePackagePath = join(runtimePackageRoot, "package.json");
const packageBytes = await readFile(runtimePackagePath);
const runtimePackage = JSON.parse(packageBytes.toString("utf8"));
const runtimeLockPath = join(runtimePackageRoot, "package-lock.json");
const lockBytes = await readFile(runtimeLockPath);

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("OMP runtime preparation currently supports only darwin-arm64");
}
if (
  runtimePackage.dependencies?.["@oh-my-pi/pi-coding-agent"] !== "18.0.11"
  || runtimePackage.dependencies?.["@oh-my-pi/pi-natives-darwin-arm64"] !== "18.0.11"
) {
  throw new Error("OMP runtime package pins are not exact 18.0.11 values");
}

const lock = JSON.parse(lockBytes.toString("utf8"));
const rootLock = lock.packages?.[""];
const codingAgentLock = lock.packages?.["node_modules/@oh-my-pi/pi-coding-agent"];
const nativeLock = lock.packages?.["node_modules/@oh-my-pi/pi-natives-darwin-arm64"];
if (
  rootLock?.dependencies?.["@oh-my-pi/pi-coding-agent"] !== "18.0.11"
  || rootLock?.dependencies?.["@oh-my-pi/pi-natives-darwin-arm64"] !== "18.0.11"
  || codingAgentLock?.version !== "18.0.11"
  || codingAgentLock?.integrity !== "sha512-3H90cCc+3yLtvSKM2RooIvkhG+77OFFoXD6+9GPZDF3PQ3FF6uCnPP57OaUa8VZ8YwOm9Eio5ZmfdFuvwLn+VA=="
  || nativeLock?.version !== "18.0.11"
  || nativeLock?.integrity !== "sha512-4XWCl30DLxRKRpcfi6OdtWhc5d7lh/f2fPkDO0xdo5n8yTkObJ+ZR9KlhJiyJI9T+e3zeztBtBMbU9ZmIgXOmg=="
) {
  throw new Error("OMP runtime lock does not match the frozen package identities");
}

await assertOutputAbsent();
const configuredArchiveUrl = process.env.ANNA_OMP_BUN_ARCHIVE_URL;
if (!configuredArchiveUrl) throw new Error("ANNA_OMP_BUN_ARCHIVE_URL is required for explicit runtime preparation");
const bunArchiveUrl = new URL(configuredArchiveUrl);
if (bunArchiveUrl.protocol !== "https:" || bunArchiveUrl.username || bunArchiveUrl.password) {
  throw new Error("Bun archive URL must use HTTPS without embedded credentials");
}
await execFileAsync("npm", [
  "ci", "--ignore-scripts", "--omit=optional", "--workspaces=false",
  "--no-audit", "--no-fund",
], { cwd: runtimePackageRoot, timeout: 120_000 });
await assertInputsUnchanged();

const temporaryRoot = await mkdtemp(join("/tmp", "anna-omp-runtime-prep-"));
try {
  const archivePath = join(temporaryRoot, "bun.zip");
  const response = await fetch(bunArchiveUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Bun archive download failed: ${response.status}`);
  const archive = await readResponseBytes(response, 64 * 1024 * 1024);
  if (sha256(archive) !== bunArchiveSha256) {
    throw new Error("Bun archive SHA-256 does not match the frozen release digest");
  }
  await writeFile(archivePath, archive);
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot, { recursive: true });
  await execFileAsync("/usr/bin/unzip", ["-q", archivePath, "-d", extractedRoot], {
    timeout: 30_000,
  });
  const bunSource = await findFile(extractedRoot, "bun");
  if (bunSource === undefined) throw new Error("Bun archive did not contain bun");
  const bunBytes = await readFile(bunSource);
  if (sha256(bunBytes) !== bunBinarySha256) {
    throw new Error("Bun binary SHA-256 does not match the frozen release digest");
  }

  const outputParent = dirname(runtimeOutputRoot);
  await mkdir(outputParent, { recursive: true });
  const stagingRoot = await mkdtemp(join(outputParent, ".staging-"));
  try {
    const bunDestination = join(stagingRoot, "bun");
    await writeFile(bunDestination, bunBytes);
    await chmod(bunDestination, 0o755);
    const nativePath = join(
      runtimePackageRoot,
      "node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node",
    );
    if (sha256(await readFile(nativePath)) !== "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b") {
      throw new Error("Pi native binary SHA-256 does not match the frozen artifact");
    }
    await cp(join(runtimePackageRoot, "node_modules"), join(stagingRoot, "node_modules"), {
      recursive: true,
    });
    await rm(join(stagingRoot, "node_modules/.bin"), { recursive: true, force: true });
    for (const name of ["canary.ts", "worker.ts", "protocol.ts", "package-lock.json"]) {
      await cp(join(runtimePackageRoot, name), join(stagingRoot, name));
    }

    const files = await collectManifestFiles(stagingRoot);
    const canonical = JSON.stringify(files);
    const payload = { schemaVersion: 1, files };
    await writeFile(
      join(stagingRoot, "manifest.json"),
      JSON.stringify({ ...payload, sha256: `sha256:${sha256(canonical)}` }) + "\n",
      "utf8",
    );
    await assertInputsUnchanged();
    await assertOutputAbsent();
    await rename(stagingRoot, runtimeOutputRoot);
    const receipt = {
      status: "ready",
      runtimeRoot: relative(repositoryRoot, runtimeOutputRoot),
      bunVersion,
      bunSha256: bunBinarySha256,
      dependencyLockSha256: sha256(lockBytes),
      manifestSha256: sha256(canonical),
      fileCount: files.length,
    };
    process.stdout.write(JSON.stringify(receipt) + "\n");
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertInputsUnchanged() {
  if (!(await readFile(runtimePackagePath)).equals(packageBytes)
    || !(await readFile(runtimeLockPath)).equals(lockBytes)) {
    throw new Error("OMP runtime preparation inputs changed during installation");
  }
}

async function assertOutputAbsent() {
  try {
    await lstat(runtimeOutputRoot);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("OMP runtime already exists; preparation will not replace a bound runtime");
}

async function readResponseBytes(response, maxBytes) {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new Error("Bun archive exceeds the preparation size limit");
  }
  if (response.body === null) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error("Bun archive exceeds the preparation size limit");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Bun archive exceeds the preparation size limit");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const found = await findFile(candidate, name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function collectManifestFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error(`OMP runtime rejects symbolic link: ${relative(root, candidate)}`);
      }
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`OMP runtime rejects non-file entry: ${relative(root, candidate)}`);
      }
      const path = relative(root, candidate).split(sep).join("/");
      const bytes = await readFile(candidate);
      files.push({ path, bytes: metadata.size, sha256: sha256(bytes) });
    }
  }
  await visit(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}
