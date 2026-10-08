import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

import { createMcpManager, type McpManager, type McpServerConfig } from "../src/workbench-mcp";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixtureServer = join(repositoryRoot, "tools/mcp-fixture-server/server.mjs");

const managers: McpManager[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function stdioFixture(extraArgs: string[] = [], overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { command: process.execPath, args: [fixtureServer, ...extraArgs], ...overrides };
}

function track(manager: McpManager): McpManager {
  managers.push(manager);
  return manager;
}

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

test("stdio server: start initializes, follows tools/list cursors and exposes stable read-only aware descriptors", async () => {
  const manager = track(createMcpManager({ fixture: stdioFixture() }));

  await manager.start();

  expect(manager.status()).toEqual([
    expect.objectContaining({ server_id: "fixture", state: "ready", tool_count: 5 }),
  ]);
  const tools = manager.tools();
  expect(tools.map((tool) => [tool.capability_id, tool.tool_name, tool.read_only])).toEqual([
    ["mcp.fixture.echo", "echo", true],
    ["mcp.fixture.add", "add", true],
    ["mcp.fixture.write_note", "write_note", false],
    ["mcp.fixture.slow", "slow", true],
    ["mcp.fixture.fail", "fail", true],
  ]);
  const echo = tools[0];
  expect(echo).toMatchObject({
    server_id: "fixture",
    description: "Return the given text unchanged.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  });
});

async function startHttpFixture(extraArgs: string[] = []): Promise<{ url: string; stop(): Promise<void> }> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [fixtureServer, "--http", "0", ...extraArgs], { stdio: ["ignore", "pipe", "ignore"] });
  const url = await new Promise<string>((resolvePromise, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("HTTP fixture did not start")), 10_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /MCP_FIXTURE_HTTP_URL=(\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[1]!);
      }
    });
  });
  return {
    url,
    stop: () => new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      child.once("exit", () => resolvePromise());
      child.kill("SIGTERM");
    }),
  };
}

for (const transport of ["stdio", "http"] as const) {
  test(`${transport}: calls read-only and write tools, keeps tool errors explicit and reports structured content`, async () => {
    const notes = await tempDirectory("anna-mcp-notes-");
    const http = transport === "http" ? await startHttpFixture(["--notes-dir", notes]) : undefined;
    try {
      const manager = track(createMcpManager({
        fixture: http === undefined ? stdioFixture(["--notes-dir", notes]) : { url: http.url },
      }));
      await manager.start();
      expect(manager.status()[0]).toMatchObject({ state: "ready", transport, tool_count: 5 });
      const signal = new AbortController().signal;

      await expect(manager.call("mcp.fixture.echo", { text: "你好 MCP" }, signal)).resolves.toEqual({
        status: "succeeded",
        output: { content: [{ type: "text", text: "你好 MCP" }], is_error: false },
      });
      const added = await manager.call("mcp.fixture.add", { a: 2, b: 40 }, signal);
      expect(added).toMatchObject({ status: "succeeded", output: { structured_content: { sum: 42 } } });

      const wrote = await manager.call("mcp.fixture.write_note", { name: "n1.txt", text: "note body" }, signal);
      expect(wrote.status).toBe("succeeded");
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(join(notes, "n1.txt"), "utf8")).toBe("note body");

      const failure = await manager.call("mcp.fixture.fail", {}, signal);
      expect(failure.status).toBe("failed");
      expect(failure.output).toMatchObject({ reason: "mcp_tool_error", is_error: true });
      expect(JSON.stringify(failure.output)).toContain("always reports an execution error");

      await expect(manager.call("mcp.fixture.unknown", {}, signal)).resolves.toMatchObject({
        status: "failed",
        output: { reason: "mcp_server_unavailable" },
      });
    } finally {
      await http?.stop();
    }
  }, 30_000);
}

test("a slow call past the server timeout fails as mcp_timeout and the server stays usable", async () => {
  const manager = track(createMcpManager({ fixture: stdioFixture([], { timeout_ms: 600 }) }));
  await manager.start();
  const signal = new AbortController().signal;
  await expect(manager.call("mcp.fixture.slow", { ms: 5_000 }, signal)).resolves.toMatchObject({
    status: "failed",
    output: { reason: "mcp_timeout" },
  });
  await expect(manager.call("mcp.fixture.echo", { text: "still alive" }, signal)).resolves.toMatchObject({ status: "succeeded" });
}, 20_000);

test("an aborted call resolves as mcp_cancelled without waiting for the server", async () => {
  const manager = track(createMcpManager({ fixture: stdioFixture() }));
  await manager.start();
  const controller = new AbortController();
  const started = Date.now();
  const pending = manager.call("mcp.fixture.slow", { ms: 10_000 }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await expect(pending).resolves.toMatchObject({ status: "failed", output: { reason: "mcp_cancelled" } });
  expect(Date.now() - started).toBeLessThan(3_000);
}, 20_000);

test("broken servers are recorded as failed without failing start, and a crash makes later calls unavailable", async () => {
  const manager = track(createMcpManager({
    missing: { command: "/nonexistent/anna-mcp-server" },
    silent: stdioFixture(["--never-initialize"], { timeout_ms: 500 }),
    crashing: stdioFixture(["--exit-on", "tools/call"]),
  }));
  await expect(manager.start()).resolves.toBeUndefined();
  const byId = Object.fromEntries(manager.status().map((item) => [item.server_id, item]));
  expect(byId.missing).toMatchObject({ state: "failed" });
  expect(byId.silent).toMatchObject({ state: "failed" });
  expect(byId.silent!.error).toContain("mcp_timeout");
  expect(byId.crashing).toMatchObject({ state: "ready" });
  const signal = new AbortController().signal;
  await expect(manager.call("mcp.crashing.echo", { text: "x" }, signal)).resolves.toMatchObject({
    status: "failed",
    output: { reason: "mcp_server_unavailable" },
  });
  expect(manager.status().find((item) => item.server_id === "crashing")).toMatchObject({ state: "failed" });
  await expect(manager.call("mcp.crashing.echo", { text: "x" }, signal)).resolves.toMatchObject({
    output: { reason: "mcp_server_unavailable" },
  });
}, 20_000);

test("stdio servers never inherit the Host environment", async () => {
  process.env.ANNA_TEST_MCP_SECRET = "must-not-leak-7731";
  try {
    const manager = track(createMcpManager({ fixture: stdioFixture(["--env-tool"], { env: { FIXTURE_VISIBLE: "yes" } }) }));
    await manager.start();
    const report = await manager.call("mcp.fixture.env_report", {}, new AbortController().signal);
    expect(report.status).toBe("succeeded");
    const text = JSON.stringify(report.output);
    expect(text).not.toContain("must-not-leak-7731");
    expect(text).toContain("FIXTURE_VISIBLE");
    const environment = JSON.parse((report.output.content as Array<{ text: string }>)[0]!.text) as Record<string, string>;
    // macOS adds __CF_USER_TEXT_ENCODING inside every child process; it does not come from the Host.
    const keys = Object.keys(environment).filter((key) => !key.startsWith("__CF_")).sort();
    expect(keys).toEqual(["FIXTURE_VISIBLE", "HOME", "LANG", "PATH", "TMPDIR"].sort());
  } finally {
    delete process.env.ANNA_TEST_MCP_SECRET;
  }
}, 20_000);

test("capability ids are sanitized, collision-free and skip tools with unusable schemas", async () => {
  const manager = track(createMcpManager({ "My Server": stdioFixture(["--extra-tools"]) }));
  await manager.start();
  const ids = manager.tools().map((tool) => tool.capability_id);
  expect(ids).toContain("mcp.my_server.echo");
  expect(ids).toContain("mcp.my_server.echo_2");
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => /^mcp\.[a-z0-9_-]+\.[a-z0-9_-]+$/.test(id) && !id.includes("__"))).toBe(true);
  expect(manager.status()[0]!.skipped_tools?.length ?? 0).toBeGreaterThan(0);
}, 20_000);

test("loadMcpConfig reads the protected Host file and rejects malformed input explicitly", async () => {
  const { loadMcpConfig } = await import("../src/workbench-mcp");
  const { writeFile } = await import("node:fs/promises");
  const directory = await tempDirectory("anna-mcp-config-");
  await expect(loadMcpConfig(undefined)).resolves.toEqual({});
  await expect(loadMcpConfig(join(directory, "absent.json"))).resolves.toEqual({});
  await writeFile(join(directory, "bad.json"), "{not json");
  await expect(loadMcpConfig(join(directory, "bad.json"))).rejects.toThrow("mcp_config_invalid_json");
  await writeFile(join(directory, "ok.json"), JSON.stringify({
    mcpServers: { local: { command: "node", args: ["server.mjs"], extra: true }, remote: { url: "https://mcp.example/mcp" } },
    unrelated: 1,
  }));
  await expect(loadMcpConfig(join(directory, "ok.json"))).resolves.toEqual({
    local: { command: "node", args: ["server.mjs"] },
    remote: { url: "https://mcp.example/mcp" },
  });
});
