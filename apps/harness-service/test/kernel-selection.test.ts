import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import { createPiKernelDescriptor } from "@anna/pi-loop-kernel";
import { PiLoopKernel } from "@anna/pi-loop-kernel";
import { startHarnessService } from "../src/index";
import { createLiveHarnessV2Runtime } from "../src/production";

test("explicit OMP admission is unavailable before HTTP Run claim or Pi dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-kernel-selection-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
  }), "utf8");

  let piStarts = 0;
  let modelCalls = 0;
  let toolFactoryCalls = 0;
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel: ({ toolGatewayFor, workerProfileId }) => {
      const provider = fauxProvider();
      const actual = new PiLoopKernel({
        model: {
          ...provider.getModel(),
          id: "fixture-model",
          name: "fixture-model",
          provider: "anna-openai-compatible",
        },
        workerProfileId,
        createToolGateway: (command) => {
          toolFactoryCalls += 1;
          return toolGatewayFor(command);
        },
        streamFn: () => {
          modelCalls += 1;
          const stream = createAssistantMessageEventStream();
          const message = fauxAssistantMessage("unexpected model dispatch");
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          return stream;
        },
        getApiKey: () => "fixture-key",
        now: () => 0,
      });
      return {
        async start(command, sink, signal) {
          piStarts += 1;
          return actual.start(command, sink, signal);
        },
        steer: actual.steer.bind(actual),
        answer: actual.answer.bind(actual),
        abort: actual.abort.bind(actual),
      };
    },
  });
  const service = await startHarnessService({ runtime: live.runtime });

  try {
    const response = await fetch(`${service.url}/v2/surfaces/cowork/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: "workspace-kernel-selection",
        channel_id: "channel-kernel-selection",
        command_id: "command-kernel-selection",
        run_id: "run-kernel-selection",
        source_event_id: "event-kernel-selection-source",
        goal: "Select the unavailable OMP adapter.",
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(JSON.stringify({
      code: "kernel_unavailable",
      requested_adapter: "omp",
      reason: "managed_runtime_unavailable",
    }));
    expect(piStarts).toBe(0);
    expect(modelCalls).toBe(0);
    expect(toolFactoryCalls).toBe(0);

    const command = await live.eventStore.scope({
      workspaceId: "workspace-kernel-selection" as never,
      channelId: "channel-kernel-selection" as never,
    }).getRunCommand("run-kernel-selection" as never);
    expect(command).toBeUndefined();
    const events: unknown[] = [];
    for await (const event of live.eventStore.scope({
      workspaceId: "workspace-kernel-selection" as never,
      channelId: "channel-kernel-selection" as never,
    }).read("run-kernel-selection" as never)) {
      events.push(event);
    }
    expect(events).toEqual([]);
  } finally {
    await service.close();
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["absent", "explicit"] as const)(
  "new %s Pi admission persists the actual kernel descriptor",
  async (selection) => {
    const directory = await mkdtemp(join(tmpdir(), "anna-kernel-selection-pi-"));
    const configPath = join(directory, "runtime.json");
    const eventStorePath = join(directory, "events.sqlite");
    const config: Record<string, unknown> = {
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-key",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
    };
    if (selection === "explicit") config.harness_v2_kernel = "pi";
    await writeFile(configPath, JSON.stringify(config), "utf8");

    const live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot: directory,
      surfaces: ["cowork"],
      createKernel: () => ({
        async start() {
          return { status: "failed" as const };
        },
        async steer() {},
        async answer() {},
        async abort() {},
      }),
    });

    try {
      await live.runtime.start("cowork", {
        workspace_id: "workspace-kernel-selection-pi",
        channel_id: "channel-kernel-selection-pi",
        command_id: "command-kernel-selection-pi",
        run_id: "run-kernel-selection-pi",
        source_event_id: "event-kernel-selection-pi-source",
        goal: "Persist the admitted Pi identity.",
      });
      const command = await live.eventStore.scope({
        workspaceId: "workspace-kernel-selection-pi" as never,
        channelId: "channel-kernel-selection-pi" as never,
      }).getRunCommand("run-kernel-selection-pi" as never);

      expect(command?.runProfileSnapshot.kernel).toEqual(await createPiKernelDescriptor());
    } finally {
      await live.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["", "omp-v2", null, 42, {}])(
  "invalid trusted kernel selector %j is rejected without a Run",
  async (selector) => {
    const directory = await mkdtemp(join(tmpdir(), "anna-kernel-selection-invalid-"));
    const configPath = join(directory, "runtime.json");
    const eventStorePath = join(directory, "events.sqlite");
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-key",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: selector,
    }), "utf8");
    const live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot: directory,
      surfaces: ["cowork"],
      createKernel: () => ({
        async start() {
          throw new Error("kernel must not start");
        },
        async steer() {},
        async answer() {},
        async abort() {},
      }),
    });
    const service = await startHarnessService({ runtime: live.runtime });

    try {
      const response = await fetch(`${service.url}/v2/surfaces/cowork/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: "workspace-kernel-selection-invalid",
          channel_id: "channel-kernel-selection-invalid",
          command_id: "command-kernel-selection-invalid",
          run_id: "run-kernel-selection-invalid",
          source_event_id: "event-kernel-selection-invalid-source",
          goal: "Reject the invalid selector.",
        }),
      });

      expect(response.status).toBe(503);
      expect(await response.text()).toBe(JSON.stringify({
        code: "kernel_selection_invalid",
      }));
      expect(await live.eventStore.scope({
        workspaceId: "workspace-kernel-selection-invalid" as never,
        channelId: "channel-kernel-selection-invalid" as never,
      }).getRunCommand("run-kernel-selection-invalid" as never)).toBeUndefined();
    } finally {
      await service.close();
      await live.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("selector admission preserves existing invalid-body precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-kernel-selection-body-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
  }), "utf8");
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
  });
  const service = await startHarnessService({ runtime: live.runtime });
  try {
    const response = await fetch(`${service.url}/v2/surfaces/cowork/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "v2_runtime_failed" });
  } finally {
    await service.close();
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});
