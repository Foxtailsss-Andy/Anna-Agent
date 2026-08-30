import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiLoopKernel } from "@anna/pi-loop-kernel";
import { SqliteEventStore } from "@anna/event-store";
import type { CanonicalEvent } from "@anna/harness-v2";
import { createLiveHarnessV2Runtime } from "../src/production";

test("production Host rejects a second owner of the same SQLite file through an alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-host-owner-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  let first: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let second: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  try {
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible", model_name: "fixture-model",
      model_api_key: "fixture-key", model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "pi",
    }));
    first = await createLiveHarnessV2Runtime({ runtimeConfigPath: configPath, eventStorePath, workspaceRoot: directory });
    const alias = join(directory, "alias.sqlite");
    await symlink(eventStorePath, alias);
    await expect((async () => {
      second = await createLiveHarnessV2Runtime({ runtimeConfigPath: configPath, eventStorePath: alias, workspaceRoot: directory });
    })()).rejects.toMatchObject({ code: "HARNESS_HOST_ALREADY_OWNED" });
    await first.close();
    first = undefined;
    second = await createLiveHarnessV2Runtime({ runtimeConfigPath: configPath, eventStorePath: alias, workspaceRoot: directory });
  } finally {
    await second?.close();
    await first?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("production close waits for the real durable Eval ACK and terminal write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-host-eval-close-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let contender: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let closing: Promise<unknown> | undefined;
  let modelCalls = 0;
  let releaseEval!: () => void;
  let evalReached!: () => void;
  const evalBarrier = new Promise<void>((resolveBarrier) => { releaseEval = resolveBarrier; });
  const evalReady = new Promise<void>((resolveReady) => { evalReached = resolveReady; });
  try {
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible", model_name: "fixture-model",
      model_api_key: "fixture-key", model_endpoint: "https://provider.invalid/v1/chat/completions",
    }));
    const provider = fauxProvider();
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath, eventStorePath, workspaceRoot: directory,
      createKernel: ({ toolGatewayFor, prepareContext, workerProfileId }) => new PiLoopKernel({
        model: { ...provider.getModel(), id: "fixture-model", name: "fixture-model", provider: "anna-openai-compatible" },
        createToolGateway: toolGatewayFor, prepareContext, workerProfileId, getApiKey: () => "fixture-key",
        streamFn: () => {
          modelCalls += 1;
          const stream = createAssistantMessageEventStream();
          const message = fauxAssistantMessage("completed fixture");
          stream.push({ type: "done", reason: "stop", message });
          return stream;
        },
      }),
    });
    const scope = live.eventStore.scope.bind(live.eventStore);
    live.eventStore.scope = (binding) => {
      const store = scope(binding);
      return new Proxy(store, {
        get(target, key) {
          if (key === "append") return async (event: CanonicalEvent) => {
            await target.append(event);
            if (event.type === "run.eval.contract") { evalReached(); await evalBarrier; }
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    await live.runtime.start("cowork", {
      workspace_id: "w-close", channel_id: "c-close", run_id: "r-close",
      command_id: "cmd-close", source_event_id: "src-close", goal: "Complete the close fixture.",
    });
    await evalReady;
    expect(modelCalls).toBe(1);
    let closed = false;
    const firstClose = live.close();
    expect(live.close()).toBe(firstClose);
    closing = Promise.resolve(firstClose).then(() => { closed = true; });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    expect(closed).toBe(false);
    await expect((async () => {
      contender = await createLiveHarnessV2Runtime({ runtimeConfigPath: configPath, eventStorePath, workspaceRoot: directory });
    })()).rejects.toMatchObject({ code: "HARNESS_HOST_ALREADY_OWNED" });
    releaseEval();
    await closing;
    live = undefined;
    const reopened = new SqliteEventStore(eventStorePath);
    try {
      const events: CanonicalEvent[] = [];
      for await (const event of reopened.scope({ workspaceId: "w-close", channelId: "c-close" } as never).read("r-close" as never)) events.push(event);
      expect(events.at(-2)?.type).toBe("run.eval.contract");
      expect(events.at(-1)?.type).toBe("run.completed");
    } finally { reopened.close(); }
  } finally {
    releaseEval();
    if (closing !== undefined) await closing;
    else await live?.close();
    await contender?.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("failed production initialization releases Store ownership for a subsequent Host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-host-init-failure-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  try {
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible", model_name: "fixture-model",
      model_api_key: "fixture-key", model_endpoint: "https://provider.invalid/v1/chat/completions",
    }));
    await expect(createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath, eventStorePath, workspaceRoot: directory,
      createKernel: () => { throw new Error("fixture initialization failed"); },
    })).rejects.toThrow("fixture initialization failed");
    live = await createLiveHarnessV2Runtime({ runtimeConfigPath: configPath, eventStorePath, workspaceRoot: directory });
  } finally {
    await live?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
