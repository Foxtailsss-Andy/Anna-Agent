import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SqliteEventStore } from "@anna/event-store";
import type { CanonicalEvent } from "@anna/harness-v2";
import { expect, test } from "vitest";

import { startHarnessService } from "../src/index";
import { startProductHost } from "../src/product-facade";
import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { HOST_CONTEXT_PROJECTION } from "../src/host-memory-context";
import { ProductSessionStore } from "../src/product-session";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");
const skillId = "skill:harness-v2/general-assistant";
const skillPath = "skills/harness-v2/general-assistant/SKILL.md";

test("Skill restore keeps the captured version while a new Run reads the updated registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-skill-restore-"));
  const workspaceRoot = join(directory, "workspace");
  const v1Root = join(directory, "workbench-capability-skill-repository-v1");
  const v2Root = join(directory, "workbench-capability-skill-repository-v2");
  await mkdir(workspaceRoot, { recursive: true });
  await cp(join(repositoryRoot, "skills"), join(v1Root, "skills"), { recursive: true });
  await cp(join(repositoryRoot, "skills"), join(v2Root, "skills"), { recursive: true });
  const v1Document = await readFile(join(v1Root, skillPath), "utf8");
  const v1Hash = `sha256:${createHash("sha256").update(v1Document, "utf8").digest("hex")}`;
  const v1Content = skillBody(v1Document);
  const v2Document = v1Document
    .replace("version: 0.1.0", "version: 9.9.9")
    .replace("# Harness v2 General Assistant", "# Harness v2 General Assistant v2");
  await writeFile(join(v2Root, skillPath), v2Document, "utf8");
  const v2Hash = `sha256:${createHash("sha256").update(v2Document, "utf8").digest("hex")}`;
  const v2Content = skillBody(v2Document);

  const configPath = join(directory, "runtime.json");
  const originalEventStorePath = join(directory, "events-original.sqlite");
  const checkpointEventStorePath = join(directory, "events-checkpoint.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
  const descriptor = await createOmpKernelDescriptor(materializedRoot);
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-only",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: materializedRoot,
    harness_v2_omp_descriptor: descriptor,
  }), "utf8");

  const hostPort = await findFreePort();
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    `http://127.0.0.1:${hostPort}`,
  );
  const initialSessions = new ProductSessionStore(sessionStorePath);
  const releaseInitialModel = deferred();
  let initialLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let initialHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let resumedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumeService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let initialRequests = 0;
  let resumedRequests = 0;
  let newRunRequests = 0;
  let resumedRunFinished = false;

  try {
    initialLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: originalEventStorePath,
      workspaceRoot,
      workbenchSkillRepositoryRoot: v1Root,
      surfaces: ["create"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await initialSessions.get(runId))?.task,
      productTaskPeek: (runId) => initialSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        initialRequests += 1;
        if (initialRequests === 1) {
          yield capabilityToolResponse("skill-restore-search-1", "capabilities.search", { query: "general" });
          return;
        }
        if (initialRequests === 2) {
          yield capabilityToolResponse("skill-restore-capability-load-1", "capabilities.load", { ids: ["skills.load"] });
          return;
        }
        if (initialRequests === 3) {
          yield capabilityToolResponse("skill-restore-load-1", "skills.load", { skill_id: skillId });
          return;
        }
        await releaseInitialModel.promise;
        yield textResponse("初轮 Skill 读取已到 checkpoint");
      },
    });
    initialHost = await startProductHost({
      runtime: initialLive.runtime,
      eventStore: initialLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-skill-restore-host-token",
      sessionStore: initialSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });

    const sessionResponse = await fetch(`${initialHost.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ surface: "create" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${initialHost.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "读取登记方法并等待恢复",
        source_event_id: "wb02-skill-restore-1",
        surface: "create",
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const task = await initialSessions.get(run.run_id);
    const channelId = task!.task.channel_id!;
    const originalScope = initialLive.eventStore.scope({
      workspaceId: business.workspaceId as never,
      channelId: channelId as never,
    });
    const command = await originalScope.getRunCommand(run.run_id as never);
    expect(command).toBeDefined();
    const checkpoint = await waitForToolResult(
      initialLive.eventStore,
      business.workspaceId,
      channelId,
      run.run_id,
      "skills.load",
      "skill-restore-load-1",
    );
    const loadedResult = checkpoint.find((event) =>
      event.type === "omp.transcript.message"
      && isRecord(event.payload)
      && isRecord(event.payload.message)
      && event.payload.message.toolName === "skills.load"
      && event.payload.message.toolCallId === "skill-restore-load-1",
    );
    expect(loadedResult).toBeDefined();
    const loadedMessage = isRecord(loadedResult!.payload) && isRecord(loadedResult!.payload.message)
      ? loadedResult!.payload.message
      : undefined;
    expect(loadedMessage?.status).toBe("succeeded");
    expect(typeof loadedMessage?.content).toBe("string");
    const initialSkill = JSON.parse(loadedMessage!.content as string).skill as Record<string, unknown>;
    expect(initialSkill).toMatchObject({ skill_id: skillId, hash: v1Hash, content: v1Content });
    const contextProjection = await originalScope.loadProjection(
      HOST_CONTEXT_PROJECTION,
      run.run_id as never,
    );
    expect(contextProjection).toBeDefined();
    const checkpointLastSeq = checkpoint.at(-1)?.seq ?? -1;

    releaseInitialModel.resolve();
    await waitForTerminal(initialLive.eventStore, business.workspaceId, channelId, run.run_id);
    await initialHost.close();
    initialHost = undefined;
    await initialLive.close();
    initialLive = undefined;

    const checkpointStore = new SqliteEventStore(checkpointEventStorePath);
    try {
      const checkpointScope = checkpointStore.scope({
        workspaceId: business.workspaceId as never,
        channelId: channelId as never,
      });
      await checkpointScope.claimStart(command!);
      for (const event of checkpoint) await checkpointScope.append(event);
      const started = checkpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await checkpointScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: run.run_id as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      checkpointStore.close();
    }

    const resumedSessions = new ProductSessionStore(sessionStorePath);
    resumedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: checkpointEventStorePath,
      workspaceRoot,
      workbenchSkillRepositoryRoot: v2Root,
      surfaces: ["create"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await resumedSessions.get(runId))?.task,
      productTaskPeek: (runId) => resumedSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        if (!resumedRunFinished) {
          resumedRequests += 1;
          if (resumedRequests === 1) {
            yield capabilityToolResponse("skill-restore-resumed-load-1", "skills.load", { skill_id: skillId });
            return;
          }
          const result = parseToolResult(context.messages.at(-1));
          expect(result.skill).toMatchObject({
            skill_id: skillId,
            version: "0.1.0",
            hash: v1Hash,
            content: v1Content,
          });
          resumedRunFinished = true;
          yield textResponse("恢复后继续使用 checkpoint 版本");
          return;
        }
        newRunRequests += 1;
        if (newRunRequests === 1) {
          yield capabilityToolResponse("skill-restore-new-search-1", "capabilities.search", { query: "general" });
          return;
        }
        if (newRunRequests === 2) {
          yield capabilityToolResponse("skill-restore-new-capability-load-1", "capabilities.load", { ids: ["skills.load"] });
          return;
        }
        if (newRunRequests === 3) {
          yield capabilityToolResponse("skill-restore-new-load-1", "skills.load", { skill_id: skillId });
          return;
        }
        const result = parseToolResult(context.messages.at(-1));
        expect(result.skill).toMatchObject({
          skill_id: skillId,
          version: "9.9.9",
          hash: v2Hash,
          content: v2Content,
        });
        yield textResponse("新 Run 使用更新登记版本");
      },
    });
    resumedHost = await startProductHost({
      runtime: resumedLive.runtime,
      eventStore: resumedLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-skill-restore-host-token",
      sessionStore: resumedSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    resumeService = await startHarnessService({ runtime: resumedLive.runtime, port: await findFreePort() });
    const resumeResponse = await fetch(`${resumeService.url}/v2/surfaces/create/runs/${run.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: business.workspaceId, channel_id: channelId }),
    });
    const resumeBody = await resumeResponse.text();
    expect(resumeResponse.status, resumeBody).toBe(202);
    const resumedEvents = await waitForTerminal(resumedLive.eventStore, business.workspaceId, channelId, run.run_id);
    expect(resumedEvents.some((event) => event.type === "run.completed")).toBe(true);
    const resumedDispatch = resumedEvents.find((event) =>
      event.seq > checkpointLastSeq
      && event.type === "omp.tool.dispatch"
      && isRecord(event.payload)
      && event.payload.tool === "skills.load",
    );
    expect(resumedDispatch).toMatchObject({
      seq: expect.any(Number),
      payload: { tool: "skills.load", toolCallId: "skill-restore-resumed-load-1" },
    });
    expect(resumedEvents.filter((event) => event.seq > checkpointLastSeq && event.type === "omp.tool.dispatch")).toHaveLength(1);

    const newSessionResponse = await fetch(`${resumedHost.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ surface: "create" }),
    });
    expect(newSessionResponse.status).toBe(201);
    const newSession = await newSessionResponse.json() as { session_id: string };
    const newRunResponse = await fetch(`${resumedHost.url}/api/workbench/sessions/${newSession.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "读取新的登记方法版本",
        source_event_id: "wb02-skill-restore-new-run",
        surface: "create",
      }),
    });
    expect(newRunResponse.status).toBe(202);
    const newRun = await newRunResponse.json() as { run_id: string };
    const newTask = await resumedSessions.get(newRun.run_id);
    const newEvents = await waitForTerminal(
      resumedLive.eventStore,
      business.workspaceId,
      newTask!.task.channel_id!,
      newRun.run_id,
    );
    expect(newEvents.some((event) => event.type === "run.completed")).toBe(true);
    expect(newEvents.filter((event) => event.type === "omp.tool.dispatch").map(toolName)).toEqual([
      "capabilities.search",
      "capabilities.load",
      "skills.load",
    ]);
    await writeReceipt({
      run_id: run.run_id,
      resumed_run_id: run.run_id,
      new_run_id: newRun.run_id,
      checkpoint_last_seq: checkpointLastSeq,
      resumed_dispatch: { seq: resumedDispatch!.seq, tool: "skills.load", toolCallId: "skill-restore-resumed-load-1" },
      resumed_skill: {
        skill_id: skillId,
        version: "0.1.0",
        source: "anna-repository",
        document_hash: v1Hash,
        body_hash: contentHash(v1Content),
      },
      new_run_skill: {
        skill_id: skillId,
        version: "9.9.9",
        source: "anna-repository",
        document_hash: v2Hash,
        body_hash: contentHash(v2Content),
      },
      new_run_dispatches: newEvents.filter((event) => event.type === "omp.tool.dispatch").map((event) => ({
        seq: event.seq,
        tool: toolName(event),
        toolCallId: isRecord(event.payload) && typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined,
      })),
    }, "workbench-capability-skill-restore.json");
  } finally {
    releaseInitialModel.resolve();
    await resumeService?.close();
    await resumedHost?.close();
    await resumedLive?.close();
    await initialHost?.close();
    await initialLive?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function readRunEvents(store: SqliteEventStore, workspaceId: string, channelId: string, runId: string): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.scope({ workspaceId: workspaceId as never, channelId: channelId as never }).read(runId as never)) {
    events.push(event);
  }
  return events;
}

async function waitForToolResult(
  store: SqliteEventStore,
  workspaceId: string,
  channelId: string,
  runId: string,
  tool: string,
  toolCallId: string,
): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const events = await readRunEvents(store, workspaceId, channelId, runId);
    if (events.some((event) => event.type === "omp.transcript.message"
      && isRecord(event.payload)
      && isRecord(event.payload.message)
      && event.payload.message.role === "toolResult"
      && event.payload.message.toolName === tool
      && event.payload.message.toolCallId === toolCallId)) return events;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`tool checkpoint missing: ${tool}/${toolCallId}`);
}

async function waitForTerminal(store: SqliteEventStore, workspaceId: string, channelId: string, runId: string): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const events = await readRunEvents(store, workspaceId, channelId, runId);
    if (events.some((event) => ["run.completed", "run.failed", "run.timed_out", "run.cancelled"].includes(event.type))) return events;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`run did not terminate: ${runId}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skillBody(document: string): string {
  const closing = document.indexOf("\n---\n", 4);
  if (closing < 0) throw new Error("Skill fixture frontmatter is not closed");
  return document.slice(closing + "\n---\n".length);
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function toolName(event: CanonicalEvent): string | undefined {
  return event.type === "omp.tool.dispatch" && isRecord(event.payload) && typeof event.payload.tool === "string"
    ? event.payload.tool
    : undefined;
}

function parseToolResult(message: unknown): Record<string, any> {
  if (!isRecord(message) || message.role !== "toolResult" || message.status !== "succeeded" || typeof message.content !== "string") {
    throw new Error(`unexpected tool result: ${JSON.stringify(message)}`);
  }
  return JSON.parse(message.content) as Record<string, any>;
}

function capabilityToolResponse(id: string, name: string, input: Record<string, unknown>) {
  return {
    deltas: [{ type: "toolCall" as const, contentIndex: 0 as const, id, name, argumentsDelta: JSON.stringify(input) }],
    message: { role: "assistant" as const, content: [{ type: "toolCall" as const, id, name, arguments: input }], stopReason: "toolUse" as const },
  };
}

function textResponse(text: string) {
  return {
    deltas: [{ type: "text" as const, contentIndex: 0 as const, text }],
    message: { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const },
  };
}

async function writeReceipt(payload: Record<string, unknown>, filename: string): Promise<void> {
  const root = process.env.ANNA_WB02_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, filename), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
