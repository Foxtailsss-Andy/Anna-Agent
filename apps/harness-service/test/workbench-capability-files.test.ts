import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import { readRegisteredWorkdirFile } from "../src/workbench-files";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");
const terminalEvents = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
  "run.awaiting_input",
  "run.awaiting_approval",
]);

test("public Workbench Create reads a registered Markdown workdir through a loaded capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-"));
  const workspaceRoot = join(directory, "workspace");
  const workdirRoot = join(directory, "registered-workdir");
  const changedWorkdirRoot = join(directory, "changed-workdir");
  const paginationWorkdirRoot = join(directory, "pagination-workdir");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(workdirRoot, { recursive: true });
  await mkdir(changedWorkdirRoot, { recursive: true });
  await mkdir(paginationWorkdirRoot, { recursive: true });
  await writeFile(
    join(workdirRoot, "README.md"),
    "# Tracer\n\nFIRST_PARAGRAPH_FROM_REAL_WORKDIR\n\nSecond paragraph.\n",
    "utf8",
  );
  await writeFile(join(changedWorkdirRoot, "README.md"), "CHANGED_WORKDIR_SHOULD_NOT_BE_READ\n", "utf8");
  await writeFile(join(paginationWorkdirRoot, "UNICODE.md"), "🙂".repeat(20_000), "utf8");
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
  const descriptor = await createOmpKernelDescriptor(materializedRoot);
  const hostPort = await findFreePort();
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    `http://127.0.0.1:${hostPort}`,
  );
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-only",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: materializedRoot,
    harness_v2_omp_descriptor: descriptor,
  }), "utf8");

  const sessions = new ProductSessionStore(sessionStorePath);
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let registered: ({ id: string } & Record<string, unknown>) | undefined;
  let paginationRegistered: ({ id: string } & Record<string, unknown>) | undefined;
  const modelContexts: Array<{
    tools: Array<{ name: string; parameters: unknown }>;
    messages: unknown[];
  }> = [];
  let transportAssertionFailure: string | undefined;
  let readCount = 0;
  let runOrdinal = 0;
  let discoveredWorkdirSchema: unknown;

  try {
    const registration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: workdirRoot, name: "Tracer files" }),
    });
    expect(registration.status).toBe(200);
    registered = await registration.json() as { id: string };
    expect(registered.id).toMatch(/^[0-9a-f]{12}$/);
    const paginationRegistration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: paginationWorkdirRoot, name: "Pagination files" }),
    });
    expect(paginationRegistration.status).toBe(200);
    paginationRegistered = await paginationRegistration.json() as { id: string };

    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await sessions.get(runId))?.task,
      productTaskPeek: (runId) => sessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      protectedPaths: [eventStorePath, sessionStorePath],
      ompModelTransport: async function* (context) {
        const lastToolResult = [...context.messages]
          .reverse()
          .find((message) => isToolResultMessage(message));
        modelContexts.push({
          tools: (context.tools ?? []).map((tool) => ({ name: tool.name, parameters: tool.parameters })),
          messages: context.messages as unknown[],
        });
        try {
          if (lastToolResult === undefined) {
            runOrdinal += 1;
            readCount = 0;
            discoveredWorkdirSchema = undefined;
            expect(modelContexts.at(-1)?.tools.map((tool) => tool.name)).toEqual(["capabilities.search", "capabilities.load"]);
            yield capabilityToolResponse("search-files", "capabilities.search", { query: "workdir" });
            return;
          }
          const result = lastToolResult.toolName === "workdir.read_file"
            ? JSON.parse(lastToolResult.content) as Record<string, any>
            : parseToolResult(
              lastToolResult,
              runOrdinal === 3 && lastToolResult.toolName === "capabilities.load" ? undefined : "succeeded",
            );
          if (lastToolResult.toolName === "capabilities.search") {
            const definition = result.results.find((item: unknown) =>
              isRecord(item) && item.id === "workdir.read_file");
            if (runOrdinal === 3) {
              expect(definition).toBeUndefined();
              yield capabilityToolResponse("load-unbound-files", "capabilities.load", { ids: ["workdir.read_file"] });
              return;
            }
            expect(definition).toEqual(expect.objectContaining({ id: "workdir.read_file", status: "available" }));
            expect(definition.input_schema).toEqual(expect.objectContaining({
              type: "object",
              required: ["path"],
              additionalProperties: false,
            }));
            discoveredWorkdirSchema = definition.input_schema;
            yield capabilityToolResponse("load-files", "capabilities.load", { ids: [definition.id] });
            return;
          }
          if (lastToolResult.toolName === "capabilities.load") {
            if (runOrdinal === 3) {
              expect(lastToolResult.status).toBe("failed");
              expect(result).toEqual({ reason: "capability_not_available", ids: ["workdir.read_file"] });
              expect(modelContexts.at(-1)?.tools.some((tool) => tool.name === "workdir.read_file")).toBe(false);
              yield textResponse("当前会话未绑定工作目录，继续普通文本回答");
              return;
            }
            expect(result.loaded).toEqual(expect.arrayContaining([
              expect.objectContaining({ id: "workdir.read_file" }),
            ]));
            const loadedWorkdir = result.loaded.find((item: unknown) =>
              isRecord(item) && item.id === "workdir.read_file");
            expect(loadedWorkdir).toEqual(expect.objectContaining({
              id: "workdir.read_file",
              input_schema: discoveredWorkdirSchema,
            }));
            const activeWorkdir = modelContexts.at(-1)?.tools.find((tool) => tool.name === "workdir.read_file");
            expect(activeWorkdir).toEqual(expect.objectContaining({
              name: "workdir.read_file",
              parameters: discoveredWorkdirSchema,
            }));
            yield capabilityToolResponse("read-readme", "workdir.read_file", {
              path: runOrdinal === 1 ? "README.md" : "UNICODE.md",
              offset: 0,
              limit: runOrdinal === 1 ? 200 : 16_384,
            });
            return;
          }
          if (lastToolResult.toolName === "workdir.read_file") {
            readCount += 1;
            if (readCount === 1) {
              if (runOrdinal === 1) {
                expect(result).toEqual(expect.objectContaining({
                  path: "README.md",
                  offset: 0,
                  content: expect.stringContaining("FIRST_PARAGRAPH_FROM_REAL_WORKDIR"),
                  truncated: false,
                }));
                expect(result.end_offset).toBeGreaterThan(result.offset);
                expect(result.next_offset).toBeUndefined();
                await rename(workdirRoot, `${workdirRoot}-renamed`);
                await symlink(changedWorkdirRoot, workdirRoot, "dir");
                yield capabilityToolResponse("read-after-root-change", "workdir.read_file", {
                  path: "README.md",
                  offset: 0,
                  limit: 200,
                });
                return;
              }
              expect(result).toEqual(expect.objectContaining({
                resource_ref: `workdir:${paginationRegistered!.id}`,
                path: "UNICODE.md",
                offset: 0,
                offset_unit: "utf8_bytes",
                content: "🙂".repeat(16_384),
                end_offset: 65_536,
                next_offset: 65_536,
                truncated: true,
              }));
              yield capabilityToolResponse("read-unicode-next", "workdir.read_file", {
                path: "UNICODE.md",
                offset: result.next_offset,
                limit: 16_384,
              });
              return;
            }
            if (runOrdinal === 2) {
              expect(lastToolResult.status).toBe("succeeded");
              expect(result).toEqual(expect.objectContaining({
                resource_ref: `workdir:${paginationRegistered!.id}`,
                path: "UNICODE.md",
                offset: 65_536,
                offset_unit: "utf8_bytes",
                content: "🙂".repeat(3_616),
                end_offset: 80_000,
                truncated: false,
              }));
              yield textResponse("已读取 UNICODE.md 全部分页");
              return;
            }
            if (lastToolResult.status === "succeeded") {
              expect(result.content).toContain("CHANGED_WORKDIR_SHOULD_NOT_BE_READ");
            }
            expect(lastToolResult.status).toBe("failed");
            expect(result).toEqual({ reason: "workdir_binding_changed" });
            yield textResponse("已读取 README.md 首段：FIRST_PARAGRAPH_FROM_REAL_WORKDIR");
            return;
          }
          throw new Error(`unexpected tool result: ${lastToolResult.toolName}`);
        } catch (error) {
          transportAssertionFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-files-host-token",
      sessionStore: sessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      protectedPaths: [eventStorePath, sessionStorePath],
    });

    const sessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ surface: "create" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "读取登记工作目录中的 README.md 首段",
        source_event_id: "wb02-files-tracer",
        surface: "create",
        resource_refs: [`workdir:${registered!.id}`],
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const detail = await waitForRun(host.url, run.run_id, business.authorization, () => transportAssertionFailure);
    expect(detail.status).toBe("completed");
    expect(detail.events.filter((event) => event.type === "omp.tool.dispatch").map((event) => event.tool_name)).toEqual([
      "capabilities.search",
      "capabilities.load",
      "workdir.read_file",
      "workdir.read_file",
    ]);
    expect(JSON.stringify(modelContexts)).toContain("FIRST_PARAGRAPH_FROM_REAL_WORKDIR");
    expect(JSON.stringify(modelContexts)).not.toContain(workdirRoot);
    await writeFileReceipt(run.run_id, detail.events, "files-read-public-root-binding");

    const paginationSessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ surface: "crew" }),
    });
    expect(paginationSessionResponse.status).toBe(201);
    const paginationSession = await paginationSessionResponse.json() as { session_id: string };
    const paginationRunResponse = await fetch(`${host.url}/api/workbench/sessions/${paginationSession.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "分页读取登记工作目录中的 UNICODE.md",
        source_event_id: "wb02-files-pagination",
        surface: "crew",
        resource_refs: [`workdir:${paginationRegistered!.id}`],
      }),
    });
    expect(paginationRunResponse.status).toBe(202);
    const paginationRun = await paginationRunResponse.json() as { run_id: string };
    const paginationDetail = await waitForRun(host.url, paginationRun.run_id, business.authorization, () => transportAssertionFailure);
    expect(paginationDetail.status).toBe("completed");
    expect(paginationDetail.events.filter((event) => event.type === "omp.tool.dispatch").map((event) => event.tool_name)).toEqual([
      "capabilities.search",
      "capabilities.load",
      "workdir.read_file",
      "workdir.read_file",
    ]);
    await writeFileReceipt(paginationRun.run_id, paginationDetail.events, "files-read-public-pagination");

    const unboundRunResponse = await fetch(`${host.url}/api/workbench/sessions/${paginationSession.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "先检查当前可用能力，再回答一个普通问题",
        source_event_id: "wb02-files-unbound",
        surface: "crew",
      }),
    });
    expect(unboundRunResponse.status).toBe(202);
    const unboundRun = await unboundRunResponse.json() as { run_id: string };
    const unboundDetail = await waitForRun(host.url, unboundRun.run_id, business.authorization, () => transportAssertionFailure);
    expect(unboundDetail.status).toBe("completed");
    const unboundDispatches = unboundDetail.events
      .filter((event) => event.type === "omp.tool.dispatch")
      .map((event) => event.tool_name);
    expect(unboundDispatches).toEqual(["capabilities.search", "capabilities.load"]);
    expect(unboundDispatches).not.toContain("workdir.read_file");
    await writeFileReceipt(unboundRun.run_id, unboundDetail.events, "files-read-public-unbound");
  } finally {
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("registered workdir reader paginates UTF-8 by byte offsets within a bounded source window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-pagination-"));
  const workdirRoot = join(directory, "registered-workdir");
  await mkdir(workdirRoot, { recursive: true });
  const source = "🙂".repeat(20_000);
  await writeFile(join(workdirRoot, "UNICODE.md"), source, "utf8");
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    "http://127.0.0.1:1",
  );

  try {
    const registration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: workdirRoot, name: "Unicode files" }),
    });
    expect(registration.status).toBe(200);
    const registered = await registration.json() as { id: string };
    const boundRoot = await realpath(workdirRoot);
    const options = {
      origin: business.origin,
      serviceToken: "wb01-business-service-token",
      workspaceId: business.workspaceId,
      actorUserId: business.actorUserId,
      resourceRefs: [`workdir:${registered.id}`],
      boundRoot,
    };
    const first = await readRegisteredWorkdirFile(
      { path: "UNICODE.md", offset: 0, limit: 16_384 },
      options,
      new AbortController().signal,
    );
    expect(first.status).toBe("succeeded");
    expect(first.output).toEqual(expect.objectContaining({
      resource_ref: `workdir:${registered.id}`,
      path: "UNICODE.md",
      offset: 0,
      offset_unit: "utf8_bytes",
      range: expect.objectContaining({ offset: 0, offset_unit: "utf8_bytes" }),
      truncated: true,
    }));
    expect(first.output.content).toBe("🙂".repeat(16_384));
    expect(first.output.end_offset).toBe(65_536);
    expect(first.output.next_offset).toBe(65_536);
    expect(Buffer.byteLength(String(first.output.content), "utf8")).toBe(first.output.end_offset);

    const second = await readRegisteredWorkdirFile(
      { path: "UNICODE.md", offset: first.output.next_offset, limit: 16_384 },
      options,
      new AbortController().signal,
    );
    expect(second).toEqual({
      status: "succeeded",
      output: {
        resource_ref: `workdir:${registered.id}`,
        path: "UNICODE.md",
        offset: 65_536,
        offset_unit: "utf8_bytes",
        range: { offset: 65_536, end_offset: 80_000, offset_unit: "utf8_bytes" },
        end_offset: 80_000,
        limit: 16_384,
        content: "🙂".repeat(3_616),
        truncated: false,
      },
    });
  } finally {
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered workdir reader preserves BOM code points across byte-offset pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-bom-pages-"));
  const workdirRoot = join(directory, "registered-workdir");
  await mkdir(workdirRoot, { recursive: true });
  await writeFile(join(workdirRoot, "BOM.md"), "\uFEFFX\uFEFFY", "utf8");
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    "http://127.0.0.1:1",
  );

  try {
    const registration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: workdirRoot, name: "BOM pages" }),
    });
    expect(registration.status).toBe(200);
    const registered = await registration.json() as { id: string };
    const options = {
      origin: business.origin,
      serviceToken: "wb01-business-service-token",
      workspaceId: business.workspaceId,
      actorUserId: business.actorUserId,
      resourceRefs: [`workdir:${registered.id}`],
      boundRoot: await realpath(workdirRoot),
    };

    let offset = 0;
    const pages = [
      { content: "\uFEFF", endOffset: 3, nextOffset: 3 },
      { content: "X", endOffset: 4, nextOffset: 4 },
      { content: "\uFEFF", endOffset: 7, nextOffset: 7 },
      { content: "Y", endOffset: 8, nextOffset: undefined },
    ];
    for (const page of pages) {
      const result = await readRegisteredWorkdirFile(
        { path: "BOM.md", offset, limit: 1 },
        options,
        new AbortController().signal,
      );
      expect(result).toEqual({
        status: "succeeded",
        output: expect.objectContaining({
          resource_ref: `workdir:${registered.id}`,
          path: "BOM.md",
          offset,
          offset_unit: "utf8_bytes",
          content: page.content,
          end_offset: page.endOffset,
          truncated: page.nextOffset !== undefined,
          ...(page.nextOffset === undefined ? {} : { next_offset: page.nextOffset }),
        }),
      });
      offset = page.nextOffset ?? page.endOffset;
    }
    expect(offset).toBe(8);
  } finally {
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered workdir reader returns a BOM-only file without a next page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-bom-only-"));
  const workdirRoot = join(directory, "registered-workdir");
  await mkdir(workdirRoot, { recursive: true });
  await writeFile(join(workdirRoot, "BOM.md"), "\uFEFF", "utf8");
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    "http://127.0.0.1:1",
  );

  try {
    const registration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: workdirRoot, name: "BOM only" }),
    });
    expect(registration.status).toBe(200);
    const registered = await registration.json() as { id: string };
    const result = await readRegisteredWorkdirFile(
      { path: "BOM.md", offset: 0, limit: 1 },
      {
        origin: business.origin,
        serviceToken: "wb01-business-service-token",
        workspaceId: business.workspaceId,
        actorUserId: business.actorUserId,
        resourceRefs: [`workdir:${registered.id}`],
        boundRoot: await realpath(workdirRoot),
      },
      new AbortController().signal,
    );
    expect(result).toEqual({
      status: "succeeded",
      output: {
        resource_ref: `workdir:${registered.id}`,
        path: "BOM.md",
        offset: 0,
        offset_unit: "utf8_bytes",
        range: { offset: 0, end_offset: 3, offset_unit: "utf8_bytes" },
        end_offset: 3,
        limit: 1,
        content: "\uFEFF",
        truncated: false,
      },
    });
  } finally {
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered workdir reader rejects absolute paths and invalid UTF-8 byte offsets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-inputs-"));
  const workdirRoot = join(directory, "registered-workdir");
  const outsideFile = join(directory, "outside.txt");
  await mkdir(workdirRoot, { recursive: true });
  const source = "正文🙂";
  await writeFile(join(workdirRoot, "README.md"), source, "utf8");
  await writeFile(join(workdirRoot, "INVALID.md"), Buffer.from([0xe4, 0xb8]), "binary");
  await writeFile(outsideFile, "OUTSIDE_WORKDIR_UNIQUE_MARKER\n", "utf8");
  await symlink(outsideFile, join(workdirRoot, "outside-link.txt"), "file");
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    "http://127.0.0.1:1",
  );

  try {
    const registration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: workdirRoot, name: "Input checks" }),
    });
    expect(registration.status).toBe(200);
    const registered = await registration.json() as { id: string };
    const options = {
      origin: business.origin,
      serviceToken: "wb01-business-service-token",
      workspaceId: business.workspaceId,
      actorUserId: business.actorUserId,
      resourceRefs: [`workdir:${registered.id}`],
      boundRoot: await realpath(workdirRoot),
    };
    await expect(readRegisteredWorkdirFile(
      { path: join(workdirRoot, "README.md"), offset: 0, limit: 10 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "invalid_workdir_read_request" },
    });
    await expect(readRegisteredWorkdirFile(
      { path: "README.md", offset: 0, limit: 10, absolute: true },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "invalid_workdir_read_request" },
    });
    await expect(readRegisteredWorkdirFile(
      { path: "../outside.txt", offset: 0, limit: 100 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_path_outside_root" },
    });
    await expect(readRegisteredWorkdirFile(
      { path: "outside-link.txt", offset: 0, limit: 100 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_path_outside_root" },
    });
    await expect(readRegisteredWorkdirFile(
      { path: "README.md", offset: Buffer.byteLength(source, "utf8") + 1, limit: 10 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_offset_out_of_range" },
    });
    await expect(readRegisteredWorkdirFile(
      { path: "README.md", offset: 7, limit: 10 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_offset_not_utf8_boundary" },
    });
    await expect(readRegisteredWorkdirFile(
      { path: "INVALID.md", offset: 0, limit: 10 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_file_not_utf8" },
    });
    await rm(workdirRoot, { recursive: true, force: true });
    await expect(readRegisteredWorkdirFile(
      { path: "README.md", offset: 0, limit: 10 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_unavailable" },
    });
  } finally {
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered workdir reader preserves leading-dot names while enforcing path boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-leading-dot-"));
  const workdirRoot = join(directory, "registered-workdir");
  const outsideRoot = join(directory, "outside-parent");
  const outsideFile = join(outsideRoot, "outside.txt");
  const leadingDotDirectory = join(workdirRoot, "..data");
  const protectedLeadingDotDirectory = join(workdirRoot, "..protected");
  await mkdir(workdirRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await mkdir(leadingDotDirectory, { recursive: true });
  await mkdir(protectedLeadingDotDirectory, { recursive: true });
  await writeFile(join(workdirRoot, "..notes.md"), "LEADING_DOT_FILE\n", "utf8");
  await writeFile(join(leadingDotDirectory, "note.md"), "LEADING_DOT_DIRECTORY_FILE\n", "utf8");
  await writeFile(outsideFile, "OUTSIDE_PARENT_UNIQUE_MARKER\n", "utf8");
  await symlink(outsideFile, join(workdirRoot, "outside-link.txt"), "file");
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    "http://127.0.0.1:1",
  );

  try {
    const registration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: workdirRoot, name: "Leading dot names" }),
    });
    expect(registration.status).toBe(200);
    const registered = await registration.json() as { id: string };
    const options = {
      origin: business.origin,
      serviceToken: "wb01-business-service-token",
      workspaceId: business.workspaceId,
      actorUserId: business.actorUserId,
      resourceRefs: [`workdir:${registered.id}`],
      boundRoot: await realpath(workdirRoot),
    };

    await expect(readRegisteredWorkdirFile(
      { path: "..notes.md", offset: 0, limit: 100 },
      options,
      new AbortController().signal,
    )).resolves.toEqual(expect.objectContaining({
      status: "succeeded",
      output: expect.objectContaining({
        path: "..notes.md",
        content: "LEADING_DOT_FILE\n",
      }),
    }));
    await expect(readRegisteredWorkdirFile(
      { path: "..data/note.md", offset: 0, limit: 100 },
      options,
      new AbortController().signal,
    )).resolves.toEqual(expect.objectContaining({
      status: "succeeded",
      output: expect.objectContaining({
        path: "..data/note.md",
        content: "LEADING_DOT_DIRECTORY_FILE\n",
      }),
    }));
    await expect(readRegisteredWorkdirFile(
      { path: "../outside-parent/outside.txt", offset: 0, limit: 100 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_path_outside_root" },
    });
    await expect(readRegisteredWorkdirFile(
      { path: "outside-link.txt", offset: 0, limit: 100 },
      options,
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_path_outside_root" },
    });
    await expect(readRegisteredWorkdirFile(
      { path: "..notes.md", offset: 0, limit: 100 },
      { ...options, protectedPaths: [protectedLeadingDotDirectory] },
      new AbortController().signal,
    )).resolves.toEqual({
      status: "failed",
      output: { reason: "workdir_protected_path" },
    });
  } finally {
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeFileReceipt(
  runId: string,
  events: Array<Record<string, any> & { type: string }>,
  prefix: string,
): Promise<void> {
  const root = process.env.ANNA_WB02_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  const dispatches = events
    .filter((event) => event.type === "omp.tool.dispatch")
    .map((event) => ({ seq: event.seq, tool_name: event.tool_name }));
  const toolResponses = events
    .filter((event) => event.type === "omp.tool.response")
    .map((event) => ({ event_id: event.event_id, seq: event.seq, status: event.tool_status }));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${prefix}.json`), `${JSON.stringify({
    run_id: runId,
    dispatches,
    tool_responses: toolResponses,
    evidence_boundary: "actual Workbench OMP/Gateway with real Python identity/scope and registered files; model transport is a fixture",
  }, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResultMessage(value: unknown): value is { role: "toolResult"; toolName: string; status: string; content: string } {
  return isRecord(value)
    && value.role === "toolResult"
    && typeof value.toolName === "string"
    && typeof value.status === "string"
    && typeof value.content === "string";
}

function parseToolResult(message: { content: string; status: string }, expectedStatus: string | undefined): Record<string, any> {
  if (expectedStatus !== undefined) expect(message.status).toBe(expectedStatus);
  return JSON.parse(message.content) as Record<string, any>;
}

function capabilityToolResponse(id: string, name: string, argumentsValue: Record<string, unknown>) {
  return {
    deltas: [{ type: "toolCall" as const, contentIndex: 0 as const, id, name, argumentsDelta: JSON.stringify(argumentsValue) }],
    message: {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id, name, arguments: argumentsValue }],
      stopReason: "toolUse" as const,
    },
  };
}

function textResponse(text: string) {
  return {
    deltas: [{ type: "text" as const, contentIndex: 0 as const, text }],
    message: { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const },
  };
}

async function waitForRun(
  origin: string,
  runId: string,
  authorization: string,
  transportFailure: () => string | undefined,
): Promise<{ status: string; events: Array<Record<string, any> & { type: string; tool_name?: string }> }> {
  const startedAt = Date.now();
  let afterSeq = -1;
  const allEvents: Array<Record<string, any> & { type: string; tool_name?: string }> = [];
  while (Date.now() - startedAt < 30_000) {
    const suffix = afterSeq < 0 ? "" : `?after_seq=${afterSeq}`;
    const response = await fetch(`${origin}/api/workbench/runs/${runId}/events${suffix}`, {
      headers: { authorization },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { events: Array<Record<string, any> & { type: string; tool_name?: string }> };
    allEvents.push(...body.events);
    if (body.events.length > 0) afterSeq = body.events.at(-1)?.seq ?? afterSeq;
    const terminal = [...allEvents].reverse().find((event) => terminalEvents.has(event.type));
    if (terminal !== undefined) {
      if (terminal.type !== "run.completed") {
        throw new Error(`Workbench file tracer ended with ${terminal.type}: ${JSON.stringify(terminal)}; transport_assertion=${transportFailure() ?? "none"}`);
      }
      return { status: "completed", events: allEvents };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Workbench file tracer did not terminate within 30000ms");
}
