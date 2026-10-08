import { execFileSync, spawn } from "node:child_process";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { runSandboxedCommand, sandboxSupport, type SandboxExecOutput } from "../src/workbench-sandbox";

const support = sandboxSupport();
const describeSandbox = support.available ? describe : describe.skip;

if (!support.available) {
  // eslint-disable-next-line no-console
  console.warn(`workbench-sandbox tests skipped: ${support.reason}`);
}

function pythonFunctional(): boolean {
  try {
    const out = execFileSync("/usr/bin/python3", ["-c", "print(1+1)"], { encoding: "utf8" });
    return out.trim() === "2";
  } catch {
    return false;
  }
}

const pythonWorks = pythonFunctional();

function expectOutput(result: {
  status: "succeeded" | "failed";
  output: SandboxExecOutput | { reason: string };
}): SandboxExecOutput {
  if ("reason" in result.output) {
    throw new Error(`expected sandbox output, got reason: ${result.output.reason}`);
  }
  return result.output;
}

describeSandbox("workbench-sandbox runSandboxedCommand", () => {
  let roots: string[] = [];

  const makeWorkdir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "anna-sb-work-"));
    roots.push(dir);
    return dir;
  };

  const run = (
    input: unknown,
    workdirRoot: string,
    overrides: Partial<Parameters<typeof runSandboxedCommand>[1]> = {},
  ) =>
    runSandboxedCommand(input, {
      workdirRoot,
      protectedPaths: [],
      signal: new AbortController().signal,
      ...overrides,
    });

  beforeAll(() => {
    roots = [];
  });

  afterAll(async () => {
    for (const dir of roots) await rm(dir, { recursive: true, force: true });
  });

  test("reports availability on this darwin machine", () => {
    expect(sandboxSupport()).toEqual({ available: true });
  });

  test("denies outbound network connections", async () => {
    const workdir = await makeWorkdir();
    const command = pythonWorks
      ? `/usr/bin/python3 -c 'import socket; socket.setdefaulttimeout(3); socket.create_connection((\"1.1.1.1\", 80))'`
      : `/usr/bin/curl -sS --max-time 5 http://1.1.1.1/`;
    const result = await run({ command }, workdir);
    const output = expectOutput(result);
    expect(result.status).toBe("failed");
    expect(output.exit_code).not.toBe(0);
    expect(output.timed_out).toBe(false);
    expect(output.sandbox).toEqual(expect.objectContaining({ kind: "macos-seatbelt", network: "denied" }));
  }, 15_000);

  test("allows writes inside the workdir and they are visible on the host", async () => {
    const workdir = await makeWorkdir();
    const result = await run({ command: "printf 'hello-sandbox' > created.txt" }, workdir);
    expect(result.status).toBe("succeeded");
    expect(expectOutput(result).exit_code).toBe(0);
    const written = await readFile(join(workdir, "created.txt"), "utf8");
    expect(written).toBe("hello-sandbox");
  });

  test("denies writes to /tmp, a sibling temp dir, and the host home directory", async () => {
    const workdir = await makeWorkdir();
    const sibling = await makeWorkdir();
    const tmpTarget = join(tmpdir(), `anna-sb-deny-${Date.now()}.txt`);
    const homeTarget = join(homedir(), `anna-sb-deny-${Date.now()}.txt`);

    const toTmp = await run({ command: `printf x > ${JSON.stringify(tmpTarget)}` }, workdir);
    const toSibling = await run({ command: `printf x > ${JSON.stringify(join(sibling, "x.txt"))}` }, workdir);
    const toHome = await run({ command: `printf x > ${JSON.stringify(homeTarget)}` }, workdir);

    expect(toTmp.status).toBe("failed");
    expect(toSibling.status).toBe("failed");
    expect(toHome.status).toBe("failed");
    // Nothing escaped the sandbox.
    await expect(readFile(tmpTarget, "utf8")).rejects.toThrow();
    await expect(readFile(homeTarget, "utf8")).rejects.toThrow();
  });

  test("denies reading files in a sibling temp dir and under the host home", async () => {
    const workdir = await makeWorkdir();
    const sibling = await makeWorkdir();
    const siblingFile = join(sibling, "secret.txt");
    await writeFile(siblingFile, "SIBLING_SECRET\n", "utf8");
    const homeFile = join(homedir(), `anna-sb-read-${Date.now()}.txt`);
    await writeFile(homeFile, "HOME_SECRET\n", "utf8");
    try {
      const readSibling = await run({ command: `cat ${JSON.stringify(siblingFile)}` }, workdir);
      const readHome = await run({ command: `cat ${JSON.stringify(homeFile)}` }, workdir);
      expect(readSibling.status).toBe("failed");
      expect(expectOutput(readSibling).stdout).not.toContain("SIBLING_SECRET");
      expect(readHome.status).toBe("failed");
      expect(expectOutput(readHome).stdout).not.toContain("HOME_SECRET");
    } finally {
      await rm(homeFile, { force: true });
    }
  });

  test("allows reading a normal workdir file but denies a protected path inside the workdir", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "data.txt"), "VISIBLE_DATA\n", "utf8");
    const protectedFile = join(workdir, "typesafe.key");
    await writeFile(protectedFile, "PROTECTED_SECRET\n", "utf8");

    const readData = await run({ command: "cat data.txt" }, workdir, { protectedPaths: [protectedFile] });
    const readProtected = await run({ command: "cat typesafe.key" }, workdir, { protectedPaths: [protectedFile] });

    expect(readData.status).toBe("succeeded");
    expect(expectOutput(readData).stdout).toContain("VISIBLE_DATA");
    expect(readProtected.status).toBe("failed");
    expect(expectOutput(readProtected).stdout).not.toContain("PROTECTED_SECRET");
  });

  test("replaces the environment so host secrets never leak into the sandbox", async () => {
    const workdir = await makeWorkdir();
    const previous = process.env.ANNA_TEST_SECRET;
    process.env.ANNA_TEST_SECRET = "SENTINEL_SECRET_DO_NOT_LEAK";
    try {
      const command =
        "printf '%s\\n' \"SECRET=[${ANNA_TEST_SECRET}]\" \"PATH=[${PATH}]\" \"SANDBOX=[${ANNA_SANDBOX}]\" \"LANG=[${LANG}]\" \"HOME=[${HOME}]\"";
      const result = await run({ command }, workdir);
      const output = expectOutput(result);
      expect(result.status).toBe("succeeded");
      expect(output.stdout).not.toContain("SENTINEL_SECRET_DO_NOT_LEAK");
      expect(output.stdout).toContain("SECRET=[]");
      expect(output.stdout).toContain("PATH=[/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin]");
      expect(output.stdout).toContain("SANDBOX=[1]");
      expect(output.stdout).toContain("LANG=[en_US.UTF-8]");
      expect(output.stdout).not.toContain(`HOME=[${homedir()}]`);
    } finally {
      if (previous === undefined) delete process.env.ANNA_TEST_SECRET;
      else process.env.ANNA_TEST_SECRET = previous;
    }
  });

  test("kills the process group on timeout within ~2s", async () => {
    const workdir = await makeWorkdir();
    const result = await run({ command: "sleep 30", timeout_ms: 1_000 }, workdir);
    const output = expectOutput(result);
    expect(result.status).toBe("failed");
    expect(output.timed_out).toBe(true);
    expect(output.exit_code).toBeNull();
    expect(output.duration_ms).toBeLessThan(2_500);
  }, 8_000);

  test("kills a backgrounded child on timeout", async () => {
    const workdir = await makeWorkdir();
    const start = Date.now();
    const result = await run({ command: "sleep 30 & wait", timeout_ms: 1_000 }, workdir);
    const output = expectOutput(result);
    expect(result.status).toBe("failed");
    expect(output.timed_out).toBe(true);
    expect(Date.now() - start).toBeLessThan(3_000);
  }, 8_000);

  // R-standards2 P1.3: descendants that leave the process group must not outlive the call.
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitGone = async (pid: number, ms = 1_500): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !pidAlive(pid);
  };

  test("terminates a setsid() descendant that still holds the output pipe on timeout", async () => {
    const workdir = await makeWorkdir();
    const started = Date.now();
    const result = await run(
      { command: "perl -e 'use POSIX; setsid(); open(F, \">\", \"daemon.pid\"); print F $$; close(F); sleep 20' & sleep 30", timeout_ms: 1_000 },
      workdir,
    );
    expect(expectOutput(result).timed_out).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
    const pid = Number(await readFile(join(workdir, "daemon.pid"), "utf8"));
    expect(await waitGone(pid)).toBe(true);
  }, 15_000);

  test("terminates a fully detached descendant once the command returns", async () => {
    const workdir = await makeWorkdir();
    const started = Date.now();
    const result = await run({
      command: "perl -e 'use POSIX; if (fork() == 0) { setsid(); open(STDOUT, \">\", \"/dev/null\"); open(STDERR, \">\", \"/dev/null\"); open(F, \">\", \"daemon.pid\"); print F $$; close(F); sleep 20; exit 0 } sleep 1; exit 0'; echo returned",
    }, workdir);
    const output = expectOutput(result);
    expect(result.status).toBe("succeeded");
    expect(output.stdout).toContain("returned");
    expect(Date.now() - started).toBeLessThan(4_000);
    const pid = Number(await readFile(join(workdir, "daemon.pid"), "utf8"));
    expect(await waitGone(pid)).toBe(true);
  }, 15_000);

  test("terminates background jobs left behind when the command returns", async () => {
    const workdir = await makeWorkdir();
    const result = await run({ command: "sleep 30 > /dev/null 2>&1 & echo $! > bg.pid; echo done" }, workdir);
    expect(result.status).toBe("succeeded");
    const pid = Number(await readFile(join(workdir, "bg.pid"), "utf8"));
    expect(await waitGone(pid)).toBe(true);
  }, 10_000);

  test.each(["exit", "timeout", "abort"] as const)("terminates an unlinked marker holder on %s", async (ending) => {
    const workdir = await makeWorkdir();
    let pid: number | undefined;
    const controller = new AbortController();
    const abortTimer = ending === "abort" ? setTimeout(() => controller.abort(), 1_000) : undefined;
    try {
      const result = await run({
        command: `perl -e 'use POSIX; unlink "$ENV{HOME}/.anna-sandbox-marker" or die $!; if (fork() == 0) { setsid(); open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null"); open(F, ">", "daemon.pid"); print F $$; close(F); sleep 20; exit 0 } sleep ${ending === "exit" ? 1 : 30}; exit 0'`,
        ...(ending === "timeout" ? { timeout_ms: 1_000 } : {}),
      }, workdir, { signal: controller.signal });
      expect(result.status).toBe(ending === "exit" ? "succeeded" : "failed");
      expect(expectOutput(result).timed_out).toBe(ending !== "exit");
      pid = Number(await readFile(join(workdir, "daemon.pid"), "utf8"));
      expect(await waitGone(pid)).toBe(true);
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      if (pid !== undefined && pidAlive(pid)) {
        process.kill(pid, "SIGKILL");
        await waitGone(pid);
      }
    }
  }, 15_000);

  test("does not terminate another sandbox call or an unrelated process during cleanup", async () => {
    const workdir = await makeWorkdir();
    const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      const [first, second] = await Promise.all([
        run({ command: "sleep 30", timeout_ms: 200 }, workdir),
        run({ command: "sleep 1; echo concurrent-call-survived" }, workdir),
      ]);
      expect(expectOutput(first).timed_out).toBe(true);
      expect(second.status).toBe("succeeded");
      expect(expectOutput(second).stdout).toContain("concurrent-call-survived");
      expect(pidAlive(unrelated.pid!)).toBe(true);
    } finally {
      unrelated.kill("SIGKILL");
      await waitGone(unrelated.pid!);
    }
  }, 10_000);

  test("does not signal a snapshot PID after the OS reports a different process start identity", async () => {
    const workdir = await makeWorkdir();
    const originalExecFileSync = childProcess.execFileSync;
    let initialIdentityRead = false;
    const identitySpy = vi.spyOn(childProcess, "execFileSync").mockImplementation(((...args: Parameters<typeof execFileSync>) => {
      if (args[0] === "/bin/ps" && Array.isArray(args[1]) && args[1].includes("lstart=")) {
        if (initialIdentityRead) return "Thu Jan  1 00:00:00 1970\n";
        initialIdentityRead = true;
      }
      return Reflect.apply(originalExecFileSync, childProcess, args);
    }) as typeof execFileSync);
    syncBuiltinESMExports();
    const killSpy = vi.spyOn(process, "kill");
    try {
      // A real short-lived command exits on its own. Only the OS identity response
      // is replaced to deterministically exercise a PID changing between checks.
      const result = await run({ command: "exec /bin/sleep 0.3", timeout_ms: 100 }, workdir);
      expect(expectOutput(result).timed_out).toBe(true);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      identitySpy.mockRestore();
      syncBuiltinESMExports();
      killSpy.mockRestore();
    }
  }, 5_000);

  test("denies desktop IPC services (app list, preferences, DNS)", async () => {
    const workdir = await makeWorkdir();
    const apps = expectOutput(await run({ command: "lsappinfo front" }, workdir));
    expect(apps.stdout).not.toMatch(/ASN:/);
    const prefs = await run({ command: "defaults read -g AppleLocale" }, workdir);
    expect(prefs.status).toBe("failed");
    const dns = await run({ command: "/usr/bin/curl -sS --max-time 5 https://example.com -o /dev/null" }, workdir);
    expect(dns.status).toBe("failed");
  }, 20_000);

  test("runs ordinary developer tools under the deny-default profile", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "a.txt"), "b\na\n", "utf8");
    const result = await run({
      command: "sort a.txt | head -1 && wc -l < a.txt | tr -d ' ' && mkdir -p d/e && cp a.txt d/e/ && ls d/e && git --version >/dev/null && echo tools-ok",
    }, workdir);
    const output = expectOutput(result);
    expect(result.status).toBe("succeeded");
    expect(output.stdout.split("\n")).toEqual(expect.arrayContaining(["a", "2", "a.txt", "tools-ok"]));
  }, 15_000);

  test("marks stdout truncation when output exceeds the byte cap", async () => {
    const workdir = await makeWorkdir();
    const result = await run(
      { command: "/usr/bin/head -c 200000 /dev/zero | /usr/bin/tr '\\0' 'a'" },
      workdir,
      { maxOutputBytes: 1_000 },
    );
    const output = expectOutput(result);
    expect(output.stdout_truncated).toBe(true);
    expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThanOrEqual(1_000);
  });

  test("rejects a relative-parent cwd escape", async () => {
    const workdir = await makeWorkdir();
    const result = await run({ command: "pwd", cwd: ".." }, workdir);
    expect(result).toEqual({ status: "failed", output: { reason: "sandbox_cwd_outside_workdir" } });
  });

  test("rejects an absolute cwd", async () => {
    const workdir = await makeWorkdir();
    const result = await run({ command: "pwd", cwd: "/etc" }, workdir);
    expect(result).toEqual({ status: "failed", output: { reason: "sandbox_cwd_outside_workdir" } });
  });

  test("rejects a cwd that symlinks outside the workdir", async () => {
    const workdir = await makeWorkdir();
    const outside = await makeWorkdir();
    await symlink(outside, join(workdir, "escape"), "dir");
    const result = await run({ command: "pwd", cwd: "escape" }, workdir);
    expect(result).toEqual({ status: "failed", output: { reason: "sandbox_cwd_outside_workdir" } });
  });

  test("accepts a validated relative subdirectory as cwd", async () => {
    const workdir = await makeWorkdir();
    await mkdir(join(workdir, "sub"), { recursive: true });
    const result = await run({ command: "printf '%s' subdir-ran > marker.txt", cwd: "sub" }, workdir);
    expect(result.status).toBe("succeeded");
    const written = await readFile(join(workdir, "sub", "marker.txt"), "utf8");
    expect(written).toBe("subdir-ran");
  });

  test("reports a non-zero exit as failed with captured stdout and stderr", async () => {
    const workdir = await makeWorkdir();
    const result = await run({ command: "printf out; printf err >&2; exit 3" }, workdir);
    const output = expectOutput(result);
    expect(result.status).toBe("failed");
    expect(output.exit_code).toBe(3);
    expect(output.timed_out).toBe(false);
    expect(output.stdout).toBe("out");
    expect(output.stderr).toBe("err");
  });

  test("rejects malformed input", async () => {
    const workdir = await makeWorkdir();
    expect(await run({ command: "" }, workdir)).toEqual({
      status: "failed",
      output: { reason: "invalid_sandbox_exec_request" },
    });
    expect(await run({ command: "true", timeout_ms: -5 }, workdir)).toEqual({
      status: "failed",
      output: { reason: "invalid_sandbox_exec_request" },
    });
    expect(await run({ command: "true", unexpected: 1 }, workdir)).toEqual({
      status: "failed",
      output: { reason: "invalid_sandbox_exec_request" },
    });
  });

  test("returns cancelled when the signal is already aborted", async () => {
    const workdir = await makeWorkdir();
    const controller = new AbortController();
    controller.abort();
    const result = await runSandboxedCommand(
      { command: "true" },
      { workdirRoot: workdir, protectedPaths: [], signal: controller.signal },
    );
    expect(result).toEqual({ status: "failed", output: { reason: "cancelled" } });
  });

  test.runIf(pythonWorks)("runs python3 when it is functional", async () => {
    const workdir = await makeWorkdir();
    const result = await run({ command: "/usr/bin/python3 -c 'print(1+1)'" }, workdir);
    const output = expectOutput(result);
    expect(result.status).toBe("succeeded");
    expect(output.stdout.trim()).toBe("2");
  });

  test("records the median sandbox startup overhead over ~10 `true` runs", async () => {
    const workdir = await makeWorkdir();
    const durations: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const result = await run({ command: "true" }, workdir);
      expect(result.status).toBe("succeeded");
      durations.push(expectOutput(result).duration_ms);
    }
    durations.sort((a, b) => a - b);
    const median = (durations[4] + durations[5]) / 2;
    // eslint-disable-next-line no-console
    console.log(`[sandbox-overhead] median_ms=${median} samples=${JSON.stringify(durations)}`);
    expect(Number.isFinite(median)).toBe(true);
    expect(median).toBeGreaterThan(0);
  }, 20_000);
});
