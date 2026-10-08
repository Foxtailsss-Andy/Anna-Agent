import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  editRegisteredWorkdirFile,
  listRegisteredWorkdir,
  readRegisteredWorkdirFile,
  searchRegisteredWorkdir,
  writeRegisteredWorkdirFile,
  type WorkbenchWorkdirResolutionOptions,
} from "../src/workbench-files";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function makeWorkdir(prefix = "anna-wbfiles-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

function optionsFor(
  workdirPath: string,
  extra: Partial<WorkbenchWorkdirResolutionOptions> = {},
): WorkbenchWorkdirResolutionOptions {
  const id = "wd";
  return {
    origin: "http://business.local",
    workspaceId: "ws-1",
    actorUserId: "actor-1",
    resourceRefs: [`workdir:${id}`],
    fetchImpl: async () =>
      new Response(JSON.stringify({ workdir_id: id, workdir_path: workdirPath }), { status: 200 }),
    ...extra,
  };
}

const signal = () => new AbortController().signal;

// --- list -----------------------------------------------------------------

test("list returns immediate children at depth 1 and skips .git, node_modules and dot-dirs", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "a.txt"), "hello", "utf8");
  await writeFile(join(workdir, "b.txt"), "hello", "utf8");
  await mkdir(join(workdir, "sub"), { recursive: true });
  await writeFile(join(workdir, "sub", "c.txt"), "deep", "utf8");
  await mkdir(join(workdir, ".git"), { recursive: true });
  await writeFile(join(workdir, ".git", "config"), "x", "utf8");
  await mkdir(join(workdir, "node_modules"), { recursive: true });
  await writeFile(join(workdir, "node_modules", "pkg.js"), "x", "utf8");
  await mkdir(join(workdir, ".hidden"), { recursive: true });

  const result = await listRegisteredWorkdir({ depth: 1 }, optionsFor(workdir), signal());
  expect(result.status).toBe("succeeded");
  expect(result.output).toEqual({
    entries: [
      { path: "a.txt", type: "file", bytes: 5 },
      { path: "b.txt", type: "file", bytes: 5 },
      { path: "sub", type: "dir" },
    ],
    truncated: false,
  });
});

test("list descends into subdirectories up to the requested depth", async () => {
  const workdir = await makeWorkdir();
  await mkdir(join(workdir, "sub"), { recursive: true });
  await writeFile(join(workdir, "sub", "c.txt"), "deep", "utf8");

  const result = await listRegisteredWorkdir({ depth: 2 }, optionsFor(workdir), signal());
  expect(result.output.entries).toEqual([
    { path: "sub", type: "dir" },
    { path: join("sub", "c.txt"), type: "file", bytes: 4 },
  ]);
});

test("list reads an explicitly requested dot directory via path", async () => {
  const workdir = await makeWorkdir();
  await mkdir(join(workdir, ".git"), { recursive: true });
  await writeFile(join(workdir, ".git", "config"), "cfg", "utf8");

  const result = await listRegisteredWorkdir({ path: ".git", depth: 1 }, optionsFor(workdir), signal());
  expect(result.output.entries).toEqual([{ path: join(".git", "config"), type: "file", bytes: 3 }]);
});

test("list caps entries at 500 and flags truncation", async () => {
  const workdir = await makeWorkdir();
  await Promise.all(
    Array.from({ length: 505 }, (_, i) =>
      writeFile(join(workdir, `f${String(i).padStart(4, "0")}.txt`), "x", "utf8"),
    ),
  );
  const result = await listRegisteredWorkdir({ depth: 1 }, optionsFor(workdir), signal());
  expect(result.status).toBe("succeeded");
  expect((result.output.entries as unknown[]).length).toBe(500);
  expect(result.output.truncated).toBe(true);
});

// --- search ---------------------------------------------------------------

test("search finds literal matches with 1-based line numbers and line text", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "notes.md"), "first line\nNEEDLE here\nthird\nanother NEEDLE\n", "utf8");

  const result = await searchRegisteredWorkdir({ pattern: "NEEDLE" }, optionsFor(workdir), signal());
  expect(result.status).toBe("succeeded");
  expect(result.output).toEqual({
    matches: [
      { path: "notes.md", line: 2, text: "NEEDLE here" },
      { path: "notes.md", line: 4, text: "another NEEDLE" },
    ],
    truncated: false,
  });
});

test("search treats the pattern literally by default", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "f.txt"), "abc\na.c\n", "utf8");

  const result = await searchRegisteredWorkdir({ pattern: "a.c" }, optionsFor(workdir), signal());
  expect(result.output.matches).toEqual([{ path: "f.txt", line: 2, text: "a.c" }]);
});

test("search applies a regular expression when regex is true", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "f.txt"), "abc\na.c\naXc\n", "utf8");

  const result = await searchRegisteredWorkdir(
    { pattern: "^a.c$", regex: true },
    optionsFor(workdir),
    signal(),
  );
  expect(result.output.matches).toEqual([
    { path: "f.txt", line: 1, text: "abc" },
    { path: "f.txt", line: 2, text: "a.c" },
    { path: "f.txt", line: 3, text: "aXc" },
  ]);
});

test("search skips binary files containing a NUL byte", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "text.txt"), "SECRET value\n", "utf8");
  await writeFile(join(workdir, "bin.dat"), Buffer.from("SECRET\x00value", "binary"));

  const result = await searchRegisteredWorkdir({ pattern: "SECRET" }, optionsFor(workdir), signal());
  expect(result.output.matches).toEqual([{ path: "text.txt", line: 1, text: "SECRET value" }]);
});

test("search limits results and flags truncation", async () => {
  const workdir = await makeWorkdir();
  const lines = Array.from({ length: 50 }, () => "HIT").join("\n");
  await writeFile(join(workdir, "many.txt"), lines, "utf8");

  const result = await searchRegisteredWorkdir(
    { pattern: "HIT", max_results: 5 },
    optionsFor(workdir),
    signal(),
  );
  expect((result.output.matches as unknown[]).length).toBe(5);
  expect(result.output.truncated).toBe(true);
});

test("search rejects an invalid regular expression", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "f.txt"), "x\n", "utf8");
  const result = await searchRegisteredWorkdir(
    { pattern: "(", regex: true },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "invalid_workdir_search_request" } });
});

// --- write ----------------------------------------------------------------

test("write creates a new file and reports its byte length", async () => {
  const workdir = await makeWorkdir();
  const result = await writeRegisteredWorkdirFile(
    { path: "note.md", content: "héllo" },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({
    status: "succeeded",
    output: { path: "note.md", bytes: Buffer.byteLength("héllo", "utf8"), created: true },
  });
  expect(await readFile(join(workdir, "note.md"), "utf8")).toBe("héllo");
});

test("write refuses to overwrite an existing file unless overwrite is set", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "note.md"), "original", "utf8");

  const refused = await writeRegisteredWorkdirFile(
    { path: "note.md", content: "new" },
    optionsFor(workdir),
    signal(),
  );
  expect(refused).toEqual({ status: "failed", output: { reason: "workdir_file_exists" } });
  expect(await readFile(join(workdir, "note.md"), "utf8")).toBe("original");

  const overwritten = await writeRegisteredWorkdirFile(
    { path: "note.md", content: "new", overwrite: true },
    optionsFor(workdir),
    signal(),
  );
  expect(overwritten).toEqual({
    status: "succeeded",
    output: { path: "note.md", bytes: 3, created: false },
  });
  expect(await readFile(join(workdir, "note.md"), "utf8")).toBe("new");
});

test("write creates parent directories inside the root", async () => {
  const workdir = await makeWorkdir();
  const result = await writeRegisteredWorkdirFile(
    { path: "nested/deep/file.txt", content: "x" },
    optionsFor(workdir),
    signal(),
  );
  expect(result.status).toBe("succeeded");
  expect(await readFile(join(workdir, "nested", "deep", "file.txt"), "utf8")).toBe("x");
});

test("write refuses a path that escapes the root", async () => {
  const workdir = await makeWorkdir();
  const result = await writeRegisteredWorkdirFile(
    { path: "../escape.txt", content: "x" },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "workdir_path_outside_root" } });
});

test("write refuses a symlink whose target escapes the root", async () => {
  const workdir = await makeWorkdir();
  const outside = await makeWorkdir();
  const outsideFile = join(outside, "target.txt");
  await writeFile(outsideFile, "untouched", "utf8");
  await symlink(outsideFile, join(workdir, "link.txt"), "file");

  const result = await writeRegisteredWorkdirFile(
    { path: "link.txt", content: "pwned", overwrite: true },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "workdir_path_outside_root" } });
  expect(await readFile(outsideFile, "utf8")).toBe("untouched");
});

test("write refuses when a protected path lies inside the workdir", async () => {
  const workdir = await makeWorkdir();
  const protectedFile = join(workdir, "typesafe.key");
  await writeFile(protectedFile, "secret", { mode: 0o600 });

  const result = await writeRegisteredWorkdirFile(
    { path: "note.md", content: "x" },
    optionsFor(workdir, { protectedPaths: [protectedFile] }),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "workdir_protected_path" } });
});

test("write refuses content larger than the 1 MiB cap", async () => {
  const workdir = await makeWorkdir();
  const result = await writeRegisteredWorkdirFile(
    { path: "big.bin", content: "a".repeat(1_048_577) },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "workdir_content_too_large" } });
});

// --- edit -----------------------------------------------------------------

test("edit replaces exactly one occurrence", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "config.txt"), "mode=readonly\nname=anna\n", "utf8");

  const result = await editRegisteredWorkdirFile(
    { path: "config.txt", old_text: "mode=readonly", new_text: "mode=contained-write" },
    optionsFor(workdir),
    signal(),
  );
  const expected = "mode=contained-write\nname=anna\n";
  expect(result).toEqual({
    status: "succeeded",
    output: { path: "config.txt", bytes: Buffer.byteLength(expected, "utf8"), replacements: 1 },
  });
  expect(await readFile(join(workdir, "config.txt"), "utf8")).toBe(expected);
});

test("edit refuses when the old text is absent", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "config.txt"), "name=anna\n", "utf8");
  const result = await editRegisteredWorkdirFile(
    { path: "config.txt", old_text: "missing", new_text: "x" },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "workdir_edit_text_not_found" } });
});

test("edit refuses when the old text occurs more than once", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "config.txt"), "x\nx\n", "utf8");
  const result = await editRegisteredWorkdirFile(
    { path: "config.txt", old_text: "x", new_text: "y" },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "workdir_edit_text_not_unique" } });
  expect(await readFile(join(workdir, "config.txt"), "utf8")).toBe("x\nx\n");
});

// --- containment regressions (R-standards2 P0 / P1.1 / P1.4) ----------------

test("edit refuses a path through a symlinked directory that leads outside the root", async () => {
  const workdir = await makeWorkdir();
  const outside = await makeWorkdir();
  await writeFile(join(outside, "victim.txt"), "line=original\n", "utf8");
  await symlink(outside, join(workdir, "esc"), "dir");

  const result = await editRegisteredWorkdirFile(
    { path: "esc/victim.txt", old_text: "original", new_text: "changed" },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "workdir_path_outside_root" } });
  expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("line=original\n");
});

test("write through a symlinked directory leading outside creates nothing outside the root", async () => {
  const workdir = await makeWorkdir();
  const outside = await makeWorkdir();
  await symlink(outside, join(workdir, "link"), "dir");

  const result = await writeRegisteredWorkdirFile(
    { path: "link/newdir/x.txt", content: "x" },
    optionsFor(workdir),
    signal(),
  );
  expect(result).toEqual({ status: "failed", output: { reason: "workdir_path_outside_root" } });
  expect(await readdir(outside)).toEqual([]);
});

test("write and edit follow a symlinked directory that stays inside the root", async () => {
  const workdir = await makeWorkdir();
  await mkdir(join(workdir, "real"), { recursive: true });
  await symlink(join(workdir, "real"), join(workdir, "alias"), "dir");

  const written = await writeRegisteredWorkdirFile(
    { path: "alias/sub/note.txt", content: "v1" },
    optionsFor(workdir),
    signal(),
  );
  expect(written).toEqual({ status: "succeeded", output: { path: join("real", "sub", "note.txt"), bytes: 2, created: true } });
  const edited = await editRegisteredWorkdirFile(
    { path: "alias/sub/note.txt", old_text: "v1", new_text: "v2" },
    optionsFor(workdir),
    signal(),
  );
  expect(edited.status).toBe("succeeded");
  expect(await readFile(join(workdir, "real", "sub", "note.txt"), "utf8")).toBe("v2");
});

test("read, edit and overwrite refuse a file with a second hard link", async () => {
  const workdir = await makeWorkdir();
  const outside = await makeWorkdir();
  const outsideFile = join(outside, "shared.txt");
  await writeFile(outsideFile, "OUTSIDE_CONTENT\n", "utf8");
  await link(outsideFile, join(workdir, "shared.txt"));

  expect(await readRegisteredWorkdirFile({ path: "shared.txt" }, optionsFor(workdir), signal())).toEqual({
    status: "failed",
    output: { reason: "workdir_file_hardlinked" },
  });
  expect(await editRegisteredWorkdirFile(
    { path: "shared.txt", old_text: "OUTSIDE", new_text: "CHANGED" },
    optionsFor(workdir),
    signal(),
  )).toEqual({ status: "failed", output: { reason: "workdir_file_hardlinked" } });
  expect(await writeRegisteredWorkdirFile(
    { path: "shared.txt", content: "CHANGED", overwrite: true },
    optionsFor(workdir),
    signal(),
  )).toEqual({ status: "failed", output: { reason: "workdir_file_hardlinked" } });
  const search = await searchRegisteredWorkdir({ pattern: "OUTSIDE" }, optionsFor(workdir), signal());
  expect(search.output.matches).toEqual([]);
  expect(await readFile(outsideFile, "utf8")).toBe("OUTSIDE_CONTENT\n");
});

test("a catastrophic regular expression is bounded and never blocks the Host event loop", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "f.txt"), `${"a".repeat(48)}!\n`, "utf8");
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 50);
  const started = Date.now();
  try {
    const result = await searchRegisteredWorkdir({ pattern: "^(a+)+$", regex: true }, optionsFor(workdir), signal());
    expect(result).toEqual({ status: "failed", output: { reason: "workdir_search_timeout" } });
  } finally {
    clearInterval(ticker);
  }
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(13_000);
  // The loop kept running while the worker was stuck (≥ half of the expected 50 ms ticks).
  expect(ticks).toBeGreaterThan(elapsed / 100);
}, 20_000);

test("search is cancelled promptly when the Run is stopped", async () => {
  const workdir = await makeWorkdir();
  await writeFile(join(workdir, "f.txt"), `${"a".repeat(48)}!\n`, "utf8");
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const result = await searchRegisteredWorkdir({ pattern: "^(a+)+$", regex: true }, optionsFor(workdir), controller.signal);
  expect(result).toEqual({ status: "failed", output: { reason: "cancelled" } });
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("search rejects an over-long pattern", async () => {
  const workdir = await makeWorkdir();
  const result = await searchRegisteredWorkdir({ pattern: "x".repeat(1_001) }, optionsFor(workdir), signal());
  expect(result).toEqual({ status: "failed", output: { reason: "invalid_workdir_search_request" } });
});

test("file tools report workdir_not_bound when no workdir resource is provided", async () => {
  const workdir = await makeWorkdir();
  const unbound = optionsFor(workdir, { resourceRefs: [] });
  expect(await listRegisteredWorkdir({ depth: 1 }, unbound, signal())).toEqual({
    status: "failed",
    output: { reason: "workdir_not_bound" },
  });
  expect(await writeRegisteredWorkdirFile({ path: "x.txt", content: "y" }, unbound, signal())).toEqual({
    status: "failed",
    output: { reason: "workdir_not_bound" },
  });
});
