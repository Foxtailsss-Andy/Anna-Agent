import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";
import { runManagedOmpWorker } from "../src/worker-client";
import type { Message, Observation, ToolDefinition } from "../src/protocol";

const repository = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repository, "build/omp-runtime/darwin-arm64");
const sourceRuntimeRoot = join(repository, "packages/omp-loop-kernel/runtime");

// This covers the worker-client/actual SDK boundary; it is not production SQL recovery evidence.
test("public worker client resumes one unpaired admitted tool call by its original identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-client-restore-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  await cp(materializedRoot, runtimeRoot, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(runtimeRoot, name));
  }
  await mkdir(workspaceRoot);
  const tool: ToolDefinition = {
    name: "read_only",
    description: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
  const transcript: readonly Message[] = [
    { role: "user", content: "read notes" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "resume-call", name: "read_only", arguments: { path: "notes.txt" } }],
      stopReason: "toolUse",
      usage: { input: 0, output: 3 },
    },
  ];
  let modelCalls = 0;
  let toolCalls = 0;
  const observations: Observation[] = [];

  try {
    const result = await runManagedOmpWorker({
      runtimeRoot,
      entryPath: join(runtimeRoot, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      binding: {
        workspaceId: "workspace-client-restore",
        channelId: "channel-client-restore",
        runId: "run-client-restore",
        attemptId: "attempt-client-restore",
        commandId: "command-client-restore",
        profileHash: "profile-client-restore",
      },
      input: {
        systemPrompt: "test",
        goal: "do not repeat this goal",
        modelId: "fixture-model",
        allowedTools: [tool],
        snapshotDigest: "snapshot-client-restore",
        originalExecutionFingerprint: "fingerprint-client-restore",
        transcript,
      },
      modelTransport: async function* (context) {
        modelCalls += 1;
        expect(context.messages).toEqual([
          transcript[0],
          transcript[1],
          {
            role: "toolResult",
            toolCallId: "resume-call",
            toolName: "read_only",
            content: "notes content",
            status: "succeeded",
          },
        ]);
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "resumed" }],
            stopReason: "stop" as const,
          },
        };
      },
      toolGateway: async (name, input, toolCallId) => {
        toolCalls += 1;
        expect(name).toBe("read_only");
        expect(input).toEqual({ path: "notes.txt" });
        expect(toolCallId).toBe("resume-call");
        return { status: "succeeded" as const, output: "notes content" };
      },
      persistObservation: async (observation) => {
        observations.push(observation);
      },
    });

    expect(result.terminal.outcome).toBe("completed");
    expect(result.modelRequestCount).toBe(1);
    expect(toolCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(observations.filter((observation) => observation.type === "message_end")).toEqual([
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "resume-call",
          toolName: "read_only",
          content: "notes content",
          status: "succeeded",
        },
      },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "resumed" }], stopReason: "stop" },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("public worker client serializes a multi-tool assistant before continuing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-client-multitool-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  await cp(materializedRoot, runtimeRoot, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(runtimeRoot, name));
  }
  await mkdir(workspaceRoot);
  const tool: ToolDefinition = {
    name: "read_only",
    description: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
  let activeTools = 0;
  let maxActiveTools = 0;
  let toolCalls = 0;
  let modelCalls = 0;

  try {
    const result = await runManagedOmpWorker({
      runtimeRoot,
      entryPath: join(runtimeRoot, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      binding: {
        workspaceId: "workspace-client-multitool",
        channelId: "channel-client-multitool",
        runId: "run-client-multitool",
        attemptId: "attempt-client-multitool",
        commandId: "command-client-multitool",
        profileHash: "profile-client-multitool",
      },
      input: {
        systemPrompt: "test",
        goal: "do not repeat this goal",
        modelId: "fixture-model",
        allowedTools: [tool],
        snapshotDigest: "snapshot-client-multitool",
        originalExecutionFingerprint: "fingerprint-client-multitool",
        transcript: [{ role: "user", content: "read both notes" }],
      },
      modelTransport: async function* (context) {
        modelCalls += 1;
        if (modelCalls === 1) {
          expect(context.messages).toEqual([{ role: "user", content: "read both notes" }]);
          yield {
            deltas: [],
            message: {
              role: "assistant" as const,
              content: [
                { type: "toolCall" as const, id: "multi-a", name: "read_only", arguments: { path: "a.txt" } },
                { type: "toolCall" as const, id: "multi-b", name: "read_only", arguments: { path: "b.txt" } },
              ],
              stopReason: "toolUse" as const,
              usage: { input: 0, output: 3 },
            },
          };
          return;
        }
        expect(context.messages).toEqual([
          { role: "user", content: "read both notes" },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "multi-a", name: "read_only", arguments: { path: "a.txt" } },
              { type: "toolCall", id: "multi-b", name: "read_only", arguments: { path: "b.txt" } },
            ],
            stopReason: "toolUse",
            usage: { input: 0, output: 3 },
          },
          { role: "toolResult", toolCallId: "multi-a", toolName: "read_only", content: "multi-a result", status: "succeeded" },
          { role: "toolResult", toolCallId: "multi-b", toolName: "read_only", content: "multi-b result", status: "succeeded" },
        ]);
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "continued" }],
            stopReason: "stop" as const,
          },
        };
      },
      toolGateway: async (name, input, toolCallId) => {
        toolCalls += 1;
        expect(name).toBe("read_only");
        expect(input).toEqual({ path: toolCallId === "multi-a" ? "a.txt" : "b.txt" });
        activeTools += 1;
        maxActiveTools = Math.max(maxActiveTools, activeTools);
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 40));
        activeTools -= 1;
        return { status: "succeeded" as const, output: `${toolCallId} result` };
      },
    });

    expect(result.terminal.outcome).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(toolCalls).toBe(2);
    expect(maxActiveTools).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("public worker client restores only the pending call from a partial tool batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-client-partial-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  await cp(materializedRoot, runtimeRoot, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(runtimeRoot, name));
  }
  await mkdir(workspaceRoot);
  const tool: ToolDefinition = {
    name: "read_only",
    description: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
  const transcript: readonly Message[] = [
    { role: "user", content: "read both notes" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "partial-a", name: "read_only", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "partial-b", name: "read_only", arguments: { path: "b.txt" } },
      ],
      stopReason: "toolUse",
    },
    { role: "toolResult", toolCallId: "partial-a", toolName: "read_only", content: "partial-a result", status: "succeeded" },
  ];
  let modelCalls = 0;
  let toolCalls = 0;
  const observations: Observation[] = [];

  try {
    const result = await runManagedOmpWorker({
      runtimeRoot,
      entryPath: join(runtimeRoot, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      binding: {
        workspaceId: "workspace-client-partial",
        channelId: "channel-client-partial",
        runId: "run-client-partial",
        attemptId: "attempt-client-partial",
        commandId: "command-client-partial",
        profileHash: "profile-client-partial",
      },
      input: {
        systemPrompt: "test",
        goal: "do not repeat this goal",
        modelId: "fixture-model",
        allowedTools: [tool],
        snapshotDigest: "snapshot-client-partial",
        originalExecutionFingerprint: "fingerprint-client-partial",
        transcript,
      },
      modelTransport: async function* (context) {
        modelCalls += 1;
        if (modelCalls === 1) {
          expect(context.messages).toEqual([
            transcript[0],
            transcript[1],
            transcript[2],
            { role: "toolResult", toolCallId: "partial-b", toolName: "read_only", content: "partial-b result", status: "succeeded" },
          ]);
          yield {
            deltas: [],
            message: {
              role: "assistant" as const,
              content: [{ type: "toolCall" as const, id: "partial-next", name: "read_only", arguments: { path: "next.txt" } }],
              stopReason: "toolUse" as const,
            },
          };
          return;
        }
        expect(context.messages).toEqual([
          transcript[0],
          transcript[1],
          transcript[2],
          { role: "toolResult", toolCallId: "partial-b", toolName: "read_only", content: "partial-b result", status: "succeeded" },
          { role: "assistant", content: [{ type: "toolCall", id: "partial-next", name: "read_only", arguments: { path: "next.txt" } }], stopReason: "toolUse" },
          { role: "toolResult", toolCallId: "partial-next", toolName: "read_only", content: "partial-next result", status: "succeeded" },
        ]);
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "continued" }],
            stopReason: "stop" as const,
          },
        };
      },
      toolGateway: async (name, input, toolCallId) => {
        toolCalls += 1;
        expect(name).toBe("read_only");
        if (toolCallId === "partial-b") {
          expect(input).toEqual({ path: "b.txt" });
          return { status: "succeeded" as const, output: "partial-b result" };
        }
        expect(toolCallId).toBe("partial-next");
        expect(input).toEqual({ path: "next.txt" });
        return { status: "succeeded" as const, output: "partial-next result" };
      },
      persistObservation: async (observation) => {
        observations.push(observation);
      },
    });

    expect(result.terminal.outcome).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(toolCalls).toBe(2);
    expect(observations.filter((observation) => observation.type === "message_end")).toEqual([
      {
        type: "message_end",
        message: { role: "toolResult", toolCallId: "partial-b", toolName: "read_only", content: "partial-b result", status: "succeeded" },
      },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "toolCall", id: "partial-next", name: "read_only", arguments: { path: "next.txt" } }], stopReason: "toolUse" },
      },
      {
        type: "message_end",
        message: { role: "toolResult", toolCallId: "partial-next", toolName: "read_only", content: "partial-next result", status: "succeeded" },
      },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test.each(["missing", "changed"] as const)("public worker client rejects a restored tool request with %s raw SDK context", async mode => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-client-missing-context-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  await cp(materializedRoot, runtimeRoot, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(runtimeRoot, name));
  }
  const workerPath = join(runtimeRoot, "worker.ts");
  const workerSource = await readFile(workerPath, "utf8");
  const withoutContext = workerSource.replace(
    `const frame = this.makeFrame("tool.request", {
      toolCallId,
      name,
      input,
      ...(toolContext === undefined || this.input?.transcript === undefined ? {} : {
        context: { systemPrompt: toolContext.systemPrompt, messages: [...toolContext.messages] },
      }),
    }, requestId);`,
    mode === "missing"
      ? `const frame = this.makeFrame("tool.request", { toolCallId, name, input }, requestId);`
      : `const frame = this.makeFrame("tool.request", {
      toolCallId,
      name,
      input,
      context: {
        systemPrompt: toolContext.systemPrompt,
        messages: toolContext.messages.map((message) => message.role === "assistant"
          ? {
            ...message,
            content: message.content.map((content) => content.type === "toolCall" && content.id === toolCallId
              ? { ...content, arguments: { ...content.arguments, path: "changed.txt" } }
              : content),
          }
          : message),
      },
    }, requestId);`,
  );
  if (withoutContext === workerSource) throw new Error("raw SDK tool context fixture did not match");
  await writeFile(workerPath, withoutContext);
  await mkdir(workspaceRoot);
  const tool: ToolDefinition = {
    name: "read_only",
    description: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
  const transcript: readonly Message[] = [
    { role: "user", content: "read notes" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "missing-context-call", name: "read_only", arguments: { path: "notes.txt" } }],
      stopReason: "toolUse",
    },
  ];
  let modelCalls = 0;
  let toolCalls = 0;

  try {
    await expect(runManagedOmpWorker({
      runtimeRoot,
      entryPath: join(runtimeRoot, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      binding: {
        workspaceId: "workspace-client-missing-context",
        channelId: "channel-client-missing-context",
        runId: "run-client-missing-context",
        attemptId: "attempt-client-missing-context",
        commandId: "command-client-missing-context",
        profileHash: "profile-client-missing-context",
      },
      input: {
        systemPrompt: "test",
        goal: "do not repeat this goal",
        modelId: "fixture-model",
        allowedTools: [tool],
        snapshotDigest: "snapshot-client-missing-context",
        originalExecutionFingerprint: "fingerprint-client-missing-context",
        transcript,
      },
      modelTransport: async function* () {
        modelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "continued" }],
            stopReason: "stop" as const,
          },
        };
      },
      toolGateway: async () => {
        toolCalls += 1;
        return { status: "succeeded" as const, output: "notes" };
      },
    })).rejects.toThrow("context");
    expect(modelCalls).toBe(0);
    expect(toolCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("public worker client rejects a restored model request with mutated raw SDK context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-client-model-context-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  await cp(materializedRoot, runtimeRoot, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(runtimeRoot, name));
  }
  const workerPath = join(runtimeRoot, "worker.ts");
  const workerSource = await readFile(workerPath, "utf8");
  const withMutatedContext = workerSource.replace(
    `const frame = this.makeFrame("model.request", { modelId, context }, requestId);`,
    `const frame = this.makeFrame("model.request", {
      modelId,
      context: {
        ...context,
        messages: context.messages.map((message) => message.role === "user"
          ? { ...message, content: "changed" }
          : message),
      },
    }, requestId);`,
  );
  if (withMutatedContext === workerSource) throw new Error("raw SDK model context fixture did not match");
  await writeFile(workerPath, withMutatedContext);
  await mkdir(workspaceRoot);
  let modelCalls = 0;
  let toolCalls = 0;

  try {
    await expect(runManagedOmpWorker({
      runtimeRoot,
      entryPath: join(runtimeRoot, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      binding: {
        workspaceId: "workspace-client-model-context",
        channelId: "channel-client-model-context",
        runId: "run-client-model-context",
        attemptId: "attempt-client-model-context",
        commandId: "command-client-model-context",
        profileHash: "profile-client-model-context",
      },
      input: {
        systemPrompt: "test",
        goal: "do not repeat this goal",
        modelId: "fixture-model",
        allowedTools: [],
        snapshotDigest: "snapshot-client-model-context",
        originalExecutionFingerprint: "fingerprint-client-model-context",
        transcript: [{ role: "user", content: "continue this answer" }],
      },
      modelTransport: async function* () {
        modelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "continued" }],
            stopReason: "stop" as const,
          },
        };
      },
      toolGateway: async () => {
        toolCalls += 1;
        return { status: "succeeded" as const };
      },
    })).rejects.toThrow("history");
    expect(modelCalls).toBe(0);
    expect(toolCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
