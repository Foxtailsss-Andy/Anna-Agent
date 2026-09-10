import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");
// The fixture's 6s external response plus the OMP worker's 10s readiness
// bound needs observation headroom, while remaining well below the product's
// 180s Run wall budget.
const fixtureRunObservationWindowMs = 30_000;
// Thirteen serial migration-history Runs may each consume the observation
// window; the remaining 60s covers setup, continuation, and cleanup.
const migrationFixtureTimeoutMs = 450_000;
const terminalEventTypes = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
  "run.awaiting_input",
  "run.awaiting_approval",
]);
const terminalStatusTypes = new Set([
  "failed",
  "timed_out",
  "cancelled",
  "awaiting_input",
  "awaiting_approval",
]);

test("Product v1 migration is dry-run safe, deterministic, idempotent, and publicly readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb01-migration-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sourcePath = join(directory, "sessions.json");
  const workbenchPath = join(directory, "workbench.json");
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
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let modelCalls = 0;
  const modelContexts: unknown[][] = [];
  // Keep one legal external transport delay in this migration fixture so the
  // observer's bound cannot silently regress to the former five-second wait.
  const delayedTransportCall = 1;
  const delayedTransportMs = 6_000;

  try {
    const templatesResponse = await fetch(`${business.origin}/api/crew/templates`, { headers: { authorization: business.authorization } });
    expect(templatesResponse.status).toBe(200);
    const templates = await templatesResponse.json() as { templates: Array<{ id: string }> };
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ goal_text: "WB01 migration project", sop_template_id: templates.templates[0]!.id }),
    });
    expect(projectResponse.status).toBe(200);
    const project = await projectResponse.json() as { id: string };

    await writeFile(sourcePath, JSON.stringify([
      {
        task: {
          run_id: "legacy-run-chat",
          workspace_id: business.workspaceId,
          actor_user_id: business.actorUserId,
          surface: "chat",
          prompt: "旧约束：只使用 EUR，并保留原始结论。",
          conversation_id: "legacy-conversation",
          resource_refs: [],
        },
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:01.000Z",
      },
      {
        task: {
          run_id: "legacy-run-create",
          workspace_id: business.workspaceId,
          actor_user_id: business.actorUserId,
          surface: "create",
          prompt: "继续旧约束并生成草稿。",
          conversation_id: "legacy-conversation",
          resource_refs: [],
        },
        created_at: "2026-09-01T00:01:00.000Z",
        updated_at: "2026-09-01T00:01:01.000Z",
      },
      {
        task: {
          run_id: "other-actor-run",
          workspace_id: business.workspaceId,
          actor_user_id: "acc_other",
          surface: "chat",
          prompt: "不得泄露",
          resource_refs: [],
        },
        created_at: "2026-09-01T00:02:00.000Z",
        updated_at: "2026-09-01T00:02:01.000Z",
      },
      {
        task: {
          run_id: "legacy-project-a",
          workspace_id: business.workspaceId,
          actor_user_id: business.actorUserId,
          surface: "crew",
          prompt: "项目私聊 A",
          channel_id: `crew_channel:${project.id}`,
          conversation_id: "project-conversation-a",
          context: { project_id: project.id },
          resource_refs: [],
        },
        created_at: "2026-09-01T00:03:00.000Z",
        updated_at: "2026-09-01T00:03:01.000Z",
      },
      {
        task: {
          run_id: "legacy-project-b",
          workspace_id: business.workspaceId,
          actor_user_id: business.actorUserId,
          surface: "crew",
          prompt: "项目私聊 B",
          channel_id: `crew_channel:${project.id}`,
          conversation_id: "project-conversation-b",
          context: { project_id: project.id },
          resource_refs: [],
        },
        created_at: "2026-09-01T00:04:00.000Z",
        updated_at: "2026-09-01T00:04:01.000Z",
      },
      {
        task: {
          run_id: "legacy-fallback-run",
          workspace_id: business.workspaceId,
          actor_user_id: business.actorUserId,
          surface: "chat",
          prompt: "缺失 conversation 的旧 Run",
          channel_id: "shared-legacy-channel",
          resource_refs: [],
        },
        created_at: "2026-09-01T00:05:00.000Z",
        updated_at: "2026-09-01T00:05:01.000Z",
      },
      {
        task: {
          run_id: "legacy-conversation-collision",
          workspace_id: business.workspaceId,
          actor_user_id: business.actorUserId,
          surface: "chat",
          prompt: "conversation 恰好等于旧 Run ID",
          channel_id: "shared-legacy-channel",
          conversation_id: "legacy-fallback-run",
          resource_refs: [],
        },
        created_at: "2026-09-01T00:06:00.000Z",
        updated_at: "2026-09-01T00:06:01.000Z",
      },
      ...Array.from({ length: 7 }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        return {
          task: {
            run_id: `legacy-history-${number}`,
            workspace_id: business.workspaceId,
            actor_user_id: business.actorUserId,
            surface: "chat",
            prompt: index === 0 ? "首轮约束：必须保留这条限制。" : `历史第 ${number} 轮`,
            conversation_id: "legacy-conversation",
            resource_refs: [],
          },
          created_at: `2026-09-01T00:${String(10 + index).padStart(2, "0")}:00.000Z`,
          updated_at: `2026-09-01T00:${String(10 + index).padStart(2, "0")}:01.000Z`,
        };
      }),
    ]) + "\n", "utf8");
    let productSessions = new ProductSessionStore(sourcePath);

    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await productSessions.get(runId))?.task,
      productTaskPeek: (runId) => productSessions.peek(runId)?.task,
      ompModelTransport: async function* (context) {
        modelCalls += 1;
        modelContexts.push(context.messages as unknown[]);
        if (delayedTransportCall === modelCalls && delayedTransportMs !== undefined) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, delayedTransportMs));
        }
        yield {
          deltas: [{ type: "text", contentIndex: 0, text: "真实旧历史 assistant" }],
          message: {
            role: "assistant",
            content: [{ type: "text", text: "真实旧历史 assistant" }],
            stopReason: "stop",
          },
        };
      },
    });
    for (const [runId, surface, channelId, prompt] of [
      ["legacy-run-chat", "chat", "legacy-conversation", "旧约束：只使用 EUR，并保留原始结论。"],
      ["legacy-run-create", "create", "legacy-conversation", "继续旧约束并生成草稿。"],
      ["legacy-project-a", "crew", `crew_channel:${project.id}`, "项目私聊 A"],
      ["legacy-project-b", "crew", `crew_channel:${project.id}`, "项目私聊 B"],
      ["legacy-fallback-run", "chat", "shared-legacy-channel", "缺失 conversation 的旧 Run"],
      ["legacy-conversation-collision", "chat", "shared-legacy-channel", "conversation 恰好等于旧 Run ID"],
      ...Array.from({ length: 7 }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        return [`legacy-history-${number}`, "chat", "legacy-conversation", index === 0 ? "首轮约束：必须保留这条限制。" : `历史第 ${number} 轮`] as const;
      }),
    ] as const) {
      await live.runtime.start(surface, {
        workspace_id: business.workspaceId,
        channel_id: channelId === "chat" || channelId === "create" ? "legacy-conversation" : channelId,
        command_id: `legacy-command-${runId}`,
        run_id: runId,
        source_event_id: `legacy-source-${runId}`,
        goal: prompt,
      });
      await waitForCanonicalCompletion(
        live.eventStore,
        business.workspaceId,
        channelId === "chat" || channelId === "create" ? "legacy-conversation" : channelId,
        runId,
      );
    }
    expect(modelCalls).toBe(13);

    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb01-migration-host-token",
      sessionStore: productSessions,
      workbenchSessionStorePath: workbenchPath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const auth = { authorization: business.authorization };
    const sourceBefore = await readFile(sourcePath);
    const sourceHash = createHash("sha256").update(sourceBefore).digest("hex");
    const dryRun = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(dryRun.status).toBe(200);
    const dryBody = await dryRun.json() as Record<string, any>;
    expect(dryBody).toMatchObject({
      dry_run: true,
      matched_records: 13,
      sessions_added: 5,
      runs_added: 13,
    });
    expect(typeof dryBody.scope_source_sha256).toBe("string");
    expect(typeof dryBody.scope_source_bytes).toBe("number");
    const scopeDigest = {
      scope_source_sha256: dryBody.scope_source_sha256,
      scope_source_bytes: dryBody.scope_source_bytes,
    };
    const foreignChanged = JSON.parse(sourceBefore.toString("utf8")) as Array<Record<string, any>>;
    foreignChanged.find((record) => record.task.actor_user_id === "acc_other")!.task.prompt = "foreign change must not affect this scope";
    await writeFile(sourcePath, `${JSON.stringify(foreignChanged)}\n`, "utf8");
    const foreignDryRun = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(foreignDryRun.status).toBe(200);
    expect(await foreignDryRun.json()).toMatchObject(scopeDigest);
    await writeFile(sourcePath, sourceBefore);
    await expect(stat(workbenchPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${sourcePath}.tasks.v2.json`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sourcePath)).toEqual(sourceBefore);

    const applied = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: false }),
    });
    expect(applied.status).toBe(200);
    const appliedBody = await applied.json() as Record<string, any>;
    expect(appliedBody).toMatchObject({
      dry_run: false,
      ...scopeDigest,
      sessions_added: 5,
      runs_added: 13,
    });
    expect(await readFile(sourcePath)).toEqual(sourceBefore);

    const listed = await fetch(`${host.url}/api/workbench/sessions`, { headers: auth });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      sessions: Array<{ session_id: string; project_id?: string; runs: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> }>
    };
    expect(listedBody.sessions).toHaveLength(5);
    const legacySession = listedBody.sessions.find((item) => item.runs.some((run) => run.run_id === "legacy-run-chat"))!;
    expect(legacySession.runs.map((run) => run.run_id).slice(0, 2)).toEqual([
      "legacy-run-chat",
      "legacy-run-create",
    ]);
    expect(legacySession.runs).toHaveLength(9);
    expect(legacySession.runs.every((run) => run.status === "completed")).toBe(true);
    expect(legacySession.messages.some((message) => message.role === "assistant" && message.content === "真实旧历史 assistant")).toBe(true);
    expect(listedBody.sessions.every((item) => item.runs.every((run) => run.run_id !== "other-actor-run"))).toBe(true);
    const projectSessions = listedBody.sessions.filter((item) => item.runs.some((run) => run.run_id === "legacy-project-a" || run.run_id === "legacy-project-b"));
    expect(projectSessions).toHaveLength(2);
    expect(projectSessions.every((item) => item.runs.length === 1)).toBe(true);
    expect(projectSessions.every((item) => item.project_id === project.id)).toBe(true);
    const fallbackSessions = listedBody.sessions.filter((item) => item.runs.some((run) => run.run_id === "legacy-fallback-run" || run.run_id === "legacy-conversation-collision"));
    expect(fallbackSessions).toHaveLength(2);
    expect(fallbackSessions.flatMap((item) => item.runs).map((run) => run.conversation_source).sort()).toEqual(["conversation", "run_id_fallback"]);

    const repeated = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: false }),
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ sessions_added: 0, runs_added: 0 });

    const dryAfterApply = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(dryAfterApply.status).toBe(200);
    expect(await dryAfterApply.json()).toMatchObject({ sessions_added: 0, runs_added: 0 });

    const sessionId = legacySession.session_id;
    const continuation = await fetch(`${host.url}/api/workbench/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "新一轮继续旧约束",
        source_event_id: "new-after-migration",
        surface: "chat",
      }),
    });
    expect(continuation.status).toBe(202);
    const continuationBody = await continuation.json() as { run_id: string };
    const continuationDetail = await waitForPublicRun(host.url, continuationBody.run_id, auth);
    expect(continuationDetail).toMatchObject({
      run_id: continuationBody.run_id,
      source_event_id: "new-after-migration",
      status: "completed",
    });
    expect(modelCalls).toBe(14);
    expect(JSON.stringify(modelContexts[13])).toContain("旧约束：只使用 EUR");
    expect(JSON.stringify(modelContexts[13])).toContain("首轮约束：必须保留这条限制");
    expect(JSON.stringify(modelContexts[13])).toContain("真实旧历史 assistant");
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
    expect(continuationBody.run_id).toEqual(expect.any(String));

    const beforeRestartDetail = await fetch(`${host.url}/api/workbench/sessions/${sessionId}`, { headers: auth });
    expect(beforeRestartDetail.status).toBe(200);
    const beforeRestartBody = await beforeRestartDetail.json() as {
      runs: Array<{ run_id: string; watermark: Record<string, unknown> }>;
    };
    const watermarksBeforeRestart = Object.fromEntries(beforeRestartBody.runs.map((run) => [run.run_id, {
      event_id: run.watermark.event_id,
      seq: run.watermark.seq,
    }]));

    const targetBeforeFailure = await readFile(workbenchPath);
    await host.close();
    host = undefined;
    await live.close();
    live = undefined;
    productSessions = new ProductSessionStore(sourcePath);
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await productSessions.get(runId))?.task,
      productTaskPeek: (runId) => productSessions.peek(runId)?.task,
      ompModelTransport: async function* (context) {
        modelCalls += 1;
        modelContexts.push(context.messages as unknown[]);
        yield {
          deltas: [{ type: "text", contentIndex: 0, text: "真实旧历史 assistant" }],
          message: {
            role: "assistant",
            content: [{ type: "text", text: "真实旧历史 assistant" }],
            stopReason: "stop",
          },
        };
      },
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      serviceToken: "wb01-migration-host-token-cold-restart",
      sessionStore: productSessions,
      workbenchSessionStorePath: workbenchPath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const coldDetail = await fetch(`${host.url}/api/workbench/sessions/${sessionId}`, { headers: auth });
    expect(coldDetail.status).toBe(200);
    const coldBody = await coldDetail.json() as {
      runs: Array<{ run_id: string; source_event_id: string; watermark: Record<string, unknown> }>;
    };
    expect(coldBody.runs).toHaveLength(10);
    expect(coldBody.runs.some((run) => run.run_id === "legacy-run-chat" && run.source_event_id === "product:source:legacy-run-chat")).toBe(true);
    const watermarksAfterRestart = Object.fromEntries(coldBody.runs.map((run) => [run.run_id, {
      event_id: run.watermark.event_id,
      seq: run.watermark.seq,
    }]));
    expect(watermarksAfterRestart).toEqual(watermarksBeforeRestart);
    const coldApply = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: false }),
    });
    expect(coldApply.status).toBe(200);
    expect(await coldApply.json()).toMatchObject({ sessions_added: 0, runs_added: 0 });

    const malformedSource = Buffer.from("{ malformed legacy source\n", "utf8");
    await writeFile(sourcePath, malformedSource);
    await host.close();
    host = undefined;
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      serviceToken: "wb01-migration-host-token-restarted",
      sessionStore: productSessions,
      workbenchSessionStorePath: workbenchPath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const malformed = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toEqual({ code: "migration_source_invalid" });
    expect(await readFile(sourcePath)).toEqual(malformedSource);
    expect(await readFile(workbenchPath)).toEqual(targetBeforeFailure);

    await writeFile(sourcePath, sourceBefore);
    const repaired = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ sessions_added: 0, runs_added: 0 });

    const sourceRecords = JSON.parse(sourceBefore.toString("utf8")) as Array<Record<string, any>>;
    sourceRecords[0]!.task.prompt = "冲突的旧输入";
    const conflictingSource = Buffer.from(`${JSON.stringify(sourceRecords)}\n`, "utf8");
    await writeFile(sourcePath, conflictingSource);
    const conflict = await fetch(`${host.url}/api/workbench/migrations/product-v1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dry_run: false }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "migration_conflict" });
    expect(await readFile(sourcePath)).toEqual(conflictingSource);
    expect(await readFile(workbenchPath)).toEqual(targetBeforeFailure);
    await writeFile(sourcePath, sourceBefore);
    await writeWorkbenchReceipt({
      case: "product-v1-migration",
      source_sha256: sourceHash,
      matched_records: 13,
      sessions: listedBody.sessions.map((session) => ({
        session_id: session.session_id,
        run_ids: session.runs.map((run) => run.run_id),
      })),
      runs: listedBody.sessions.flatMap((session) => session.runs.map((run) => ({
        run_id: run.run_id,
        source_event_id: run.source_event_id,
        conversation_source: run.conversation_source,
        watermark: run.watermark,
      }))),
      model_transport_calls: modelCalls,
      usage: "unavailable",
    });
  } finally {
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, migrationFixtureTimeoutMs);

async function writeWorkbenchReceipt(payload: Record<string, unknown>): Promise<void> {
  const root = process.env.ANNA_WB01_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "workbench-session-migration.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function waitForPublicRun(
  origin: string,
  runId: string,
  auth: Record<string, string>,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastStatus: unknown;
  while (Date.now() - startedAt < fixtureRunObservationWindowMs) {
    const response = await fetch(`${origin}/api/workbench/runs/${runId}`, { headers: auth });
    if (response.ok) {
      const body = await response.json() as Record<string, unknown>;
      lastStatus = body.status;
      if (body.status === "completed") return body;
      if (typeof body.status === "string" && terminalStatusTypes.has(body.status)) {
        throw new Error(`public Workbench Run ${runId} ended with status ${body.status}`);
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `public Workbench Run ${runId} did not complete within ${fixtureRunObservationWindowMs}ms; last_status=${String(lastStatus ?? "unknown")}`,
  );
}

async function waitForCanonicalCompletion(
  eventStore: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>>["eventStore"],
  workspaceId: string,
  channelId: string,
  runId: string,
): Promise<void> {
  const scoped = eventStore.scope({ workspaceId: workspaceId as never, channelId: channelId as never });
  const startedAt = Date.now();
  let afterSeq = -1;
  let lastEvent: { type: string; seq: number } | undefined;
  while (Date.now() - startedAt < fixtureRunObservationWindowMs) {
    for await (const event of scoped.read(runId as never, afterSeq)) {
      afterSeq = event.seq;
      lastEvent = { type: event.type, seq: event.seq };
      if (event.type === "run.completed") return;
      if (terminalEventTypes.has(event.type)) {
        throw new Error(
          `canonical run ${runId} ended with ${event.type} at seq ${event.seq}`,
        );
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `canonical run ${runId} did not complete within ${fixtureRunObservationWindowMs}ms; last_event=${lastEvent?.type ?? "none"}; last_seq=${lastEvent?.seq ?? "none"}`,
  );
}
