import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, test } from "vitest";
import { launchManagedWorker } from "../src/managed-launcher";
import { encodeFrame, type HostFrame, type Message, type WorkerFrame } from "../src/protocol";

const repository = resolve(import.meta.dirname, "../../..");
let root: string;
let runtime: string;
let setupPromise: Promise<void> | undefined;

beforeAll(() => {
  setupPromise = (async () => {
    root = await mkdtemp(join(tmpdir(), "anna-omp-restore-"));
    runtime = join(root, "runtime");
    await cp(join(repository, "build/omp-runtime/darwin-arm64"), runtime, { recursive: true });
    for (const file of ["worker.ts", "protocol.ts"]) {
      await cp(join(repository, "packages/omp-loop-kernel/runtime", file), join(runtime, file));
    }
  })();
  return setupPromise;
}, 120_000);

afterAll(async () => {
  await setupPromise?.catch(() => undefined);
  if (root !== undefined) await rm(root, { recursive: true, force: true });
}, 120_000);

test("actual worker restores a consumed transcript and continues without replay", async () => {
  const transcript: readonly Message[] = [
    { role: "user", content: "read report" },
    {
      role: "assistant",
      reasoningContent: "I should inspect the report before continuing.",
      content: [{ type: "toolCall", id: "call-1", name: "read_only", arguments: { path: "report.txt" } }],
      stopReason: "toolUse",
      usage: { input: 3, output: 2 },
    },
    { role: "toolResult", toolCallId: "call-1", toolName: "read_only", content: "report body", status: "succeeded" },
  ];
  const observed: WorkerFrame[] = [];
  const contexts: unknown[] = [];
  let modelRequests = 0;
  let toolRequests = 0;
  const result = await probe({
    transcript,
    onFrame: (frame, send) => {
      if (frame.kind === "ready" || frame.kind === "event") {
        if (frame.kind === "event" && frame.event.type === "message_end") {
          expect(transcript).not.toContainEqual(frame.event.message);
        }
        send(receipt(frame));
      } else if (frame.kind === "model.request") {
        modelRequests += 1;
        contexts.push(frame.context);
        send({
          ...response(frame),
          kind: "model.end",
          index: 0,
          message: {
            role: "assistant",
            reasoningContent: "The restored report is available.",
            content: [{ type: "text", text: "continued" }],
            stopReason: "stop",
          },
        });
      } else if (frame.kind === "tool.request") {
        toolRequests += 1;
      }
    },
    observed,
    timeoutMs: 30_000,
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(modelRequests).toBe(1);
  expect(toolRequests).toBe(0);
  expect(contexts).toEqual([{
    systemPrompt: "test",
    messages: [
      transcript[0],
      transcript[1],
      transcript[2],
    ],
  }]);
  expect(observed.filter((frame) => frame.kind === "event" && frame.event.type === "message_end")).toHaveLength(1);
  expect(observed.some((frame) => frame.kind === "terminal.proposed" && frame.outcome === "completed")).toBe(true);
}, 30_000);

test("actual worker preserves a fully paired unknown tool result without replay", async () => {
  const transcript: readonly Message[] = [
    { role: "user", content: "read report" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "unknown-call", name: "read_only", arguments: { path: "report.txt" } }],
      stopReason: "toolUse",
    },
    { role: "toolResult", toolCallId: "unknown-call", toolName: "read_only", content: "indeterminate", status: "unknown" },
  ];
  const observed: WorkerFrame[] = [];
  let modelRequests = 0;
  let toolRequests = 0;
  const result = await probe({
    transcript,
    onFrame: (frame, send) => {
      if (frame.kind === "ready" || frame.kind === "event") {
        send(receipt(frame));
      } else if (frame.kind === "tool.request") {
        toolRequests += 1;
      } else if (frame.kind === "model.request") {
        modelRequests += 1;
        expect(frame.context).toEqual({ systemPrompt: "test", messages: transcript });
        send({
          ...response(frame),
          kind: "model.end",
          index: 0,
          message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" },
        });
      }
    },
    observed,
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(modelRequests).toBe(1);
  expect(toolRequests).toBe(0);
  expect(observed.at(-1)).toMatchObject({ kind: "terminal.proposed", outcome: "completed" });
}, 20_000);

test("actual worker proposes a completed assistant tail without calling continue", async () => {
  const transcript: readonly Message[] = [
    { role: "user", content: "already answered" },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
      usage: { input: 2, output: 1 },
    },
  ];
  const observed: WorkerFrame[] = [];
  let modelRequests = 0;
  let toolRequests = 0;
  const result = await probe({
    transcript,
    onFrame: (frame, send) => {
      if (frame.kind === "ready" || frame.kind === "event") send(receipt(frame));
      else if (frame.kind === "model.request") modelRequests += 1;
      else if (frame.kind === "tool.request") toolRequests += 1;
    },
    observed,
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(modelRequests).toBe(0);
  expect(toolRequests).toBe(0);
  expect(observed.filter((frame) => frame.kind === "event")).toHaveLength(0);
  expect(observed.at(-1)).toMatchObject({ kind: "terminal.proposed", outcome: "completed" });
}, 15_000);

test("actual worker resumes an admitted pending tool tail through the proxy host", async () => {
  const transcript: readonly Message[] = [
    { role: "user", content: "read report" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read_only", arguments: { path: "report.txt" } }],
      stopReason: "toolUse",
    },
  ];
  const observed: WorkerFrame[] = [];
  const contexts: unknown[] = [];
  let modelRequests = 0;
  let toolRequests = 0;
  const result = await probe({
    transcript,
    onFrame: (frame, send) => {
      if (frame.kind === "ready" || frame.kind === "event") {
        send(receipt(frame));
      } else if (frame.kind === "tool.request") {
        toolRequests += 1;
        expect(frame.name).toBe("read_only");
        send({
          ...response(frame),
          kind: "tool.result",
          toolCallId: frame.toolCallId,
          status: "succeeded",
          output: "report body",
        });
      } else if (frame.kind === "model.request") {
        modelRequests += 1;
        contexts.push(frame.context);
        send({
          ...response(frame),
          kind: "model.end",
          index: 0,
          message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" },
        });
      }
    },
    observed,
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(toolRequests).toBe(1);
  expect(modelRequests).toBe(1);
  expect(contexts).toEqual([{
    systemPrompt: "test",
    messages: [
      transcript[0],
      transcript[1],
      { role: "toolResult", toolCallId: "call-1", toolName: "read_only", content: "report body", status: "succeeded" },
    ],
  }]);
  expect(observed.filter((frame) => frame.kind === "tool.request")).toHaveLength(1);
  expect(observed.at(-1)).toMatchObject({ kind: "terminal.proposed", outcome: "completed" });
}, 15_000);

test("actual worker serializes multiple admitted proxy tools", async () => {
  const observed: WorkerFrame[] = [];
  let activeTools = 0;
  let maxActiveTools = 0;
  let toolRequests = 0;
  let modelRequests = 0;
  const result = await probe({
    transcript: [{ role: "user", content: "read both reports" }],
    onFrame: (frame, send) => {
      if (frame.kind === "ready" || frame.kind === "event") {
        send(receipt(frame));
      } else if (frame.kind === "model.request") {
        modelRequests += 1;
        send(modelRequests === 1 ? {
          ...response(frame),
          kind: "model.end",
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call-a", name: "read_only", arguments: { path: "a.txt" } },
              { type: "toolCall", id: "call-b", name: "read_only", arguments: { path: "b.txt" } },
            ],
            stopReason: "toolUse",
            usage: { input: 0, output: 3 },
          },
        } : {
          ...response(frame),
          kind: "model.end",
          index: 0,
          message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" },
        });
      } else if (frame.kind === "tool.request") {
        toolRequests += 1;
        activeTools += 1;
        maxActiveTools = Math.max(maxActiveTools, activeTools);
        setTimeout(() => {
          activeTools -= 1;
          send({
            ...response(frame),
            kind: "tool.result",
            toolCallId: frame.toolCallId,
            status: "succeeded",
            output: `${frame.toolCallId} result`,
          });
        }, 40);
      }
    },
    observed,
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(toolRequests).toBe(2);
  expect(modelRequests).toBe(2);
  expect(maxActiveTools).toBe(1);
  const assistantEventMessages = observed.flatMap((frame) =>
    frame.kind === "event" && frame.event.type === "message_end" && frame.event.message.role === "assistant"
      ? [frame.event.message]
      : []);
  expect(assistantEventMessages[0]).toEqual({
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-a", name: "read_only", arguments: { path: "a.txt" } },
      { type: "toolCall", id: "call-b", name: "read_only", arguments: { path: "b.txt" } },
    ],
    stopReason: "toolUse",
    usage: { input: 0, output: 3 },
  });
  expect(assistantEventMessages[1]).toEqual({
    role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop",
  });
  expect(observed.at(-1)).toMatchObject({ kind: "terminal.proposed", outcome: "completed" });
}, 20_000);

test("actual worker resumes only the pending member of a partially completed tool batch", async () => {
  const transcript: readonly Message[] = [
    { role: "user", content: "read both reports" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "partial-a", name: "read_only", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "partial-b", name: "read_only", arguments: { path: "b.txt" } },
      ],
      stopReason: "toolUse",
    },
    { role: "toolResult", toolCallId: "partial-a", toolName: "read_only", content: "a result", status: "succeeded" },
  ];
  const observed: WorkerFrame[] = [];
  const contexts: unknown[] = [];
  const toolContexts: unknown[] = [];
  let modelRequests = 0;
  let toolRequests = 0;
  const result = await probe({
    transcript,
    onFrame: (frame, send) => {
      if (frame.kind === "ready" || frame.kind === "event") {
        if (frame.kind === "event" && frame.event.type === "message_end") {
          expect(frame.event.message).not.toMatchObject({ toolCallId: "partial-a" });
        }
        send(receipt(frame));
      } else if (frame.kind === "tool.request") {
        toolRequests += 1;
        expect(frame.toolCallId).toBe("partial-b");
        toolContexts.push(frame.context);
        send({
          ...response(frame),
          kind: "tool.result",
          toolCallId: frame.toolCallId,
          status: "succeeded",
          output: "b result",
        });
      } else if (frame.kind === "model.request") {
        modelRequests += 1;
        contexts.push(frame.context);
        send({
          ...response(frame),
          kind: "model.end",
          index: 0,
          message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" },
        });
      }
    },
    observed,
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(toolRequests).toBe(1);
  expect(modelRequests).toBe(1);
  expect(toolContexts).toEqual([{
    systemPrompt: "test",
    messages: [
      transcript[0],
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "partial-b", name: "read_only", arguments: { path: "b.txt" } }],
        stopReason: "toolUse",
      },
    ],
  }]);
  expect(contexts).toEqual([{
    systemPrompt: "test",
    messages: [
      transcript[0],
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "partial-b", name: "read_only", arguments: { path: "b.txt" } }],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "partial-b", toolName: "read_only", content: "b result", status: "succeeded" },
    ],
  }]);
  expect(observed.filter((frame) => frame.kind === "tool.request")).toHaveLength(1);
  expect(observed.at(-1)).toMatchObject({ kind: "terminal.proposed", outcome: "completed" });
}, 20_000);

test("actual worker executes a non-read-only admitted proxy tool", async () => {
  const tool = {
    name: "workspace_read",
    description: "Read an admitted workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };
  const observed: WorkerFrame[] = [];
  const modelContexts: Array<unknown> = [];
  let modelRequests = 0;
  let toolRequests = 0;
  const result = await probe({
    allowedTools: [tool],
    onFrame: (frame, send) => {
      if (frame.kind === "ready" || frame.kind === "event") {
        send(receipt(frame));
      } else if (frame.kind === "model.request") {
        modelRequests += 1;
        modelContexts.push(frame.context);
        send(modelRequests === 1 ? {
          ...response(frame),
          kind: "model.end",
          index: 0,
          message: {
            role: "assistant",
            reasoningContent: "I need the workspace file.",
            content: [{ type: "toolCall", id: "workspace-call", name: "workspace_read", arguments: { path: "report.txt" } }],
            stopReason: "toolUse",
          },
        } : {
          ...response(frame),
          kind: "model.end",
          index: 0,
          message: {
            role: "assistant",
            reasoningContent: "The workspace file is ready.",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
          },
        });
      } else if (frame.kind === "tool.request") {
        toolRequests += 1;
        expect(frame.name).toBe("workspace_read");
        send({ ...response(frame), kind: "tool.result", toolCallId: frame.toolCallId, status: "succeeded", output: "report body" });
      }
    },
    observed,
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(modelRequests).toBe(2);
  expect(toolRequests, JSON.stringify(observed)).toBe(1);
  expect(modelContexts[0]).toMatchObject({ tools: [tool] });
  expect(modelContexts[1]).toMatchObject({ tools: [tool], messages: [
    { role: "user", content: "do not repeat this goal" },
    { role: "assistant", content: [{ type: "toolCall", name: "workspace_read" }], stopReason: "toolUse" },
    { role: "toolResult", toolName: "workspace_read", content: "report body", status: "succeeded" },
  ] });
  expect(observed.at(-1)).toMatchObject({ kind: "terminal.proposed", outcome: "completed" });
}, 20_000);

test("actual worker uses native TodoTool and carries its phases through the loop", async () => {
  const todo = {
    name: "todo",
    description: "Track work.",
    parameters: { type: "object" },
  };
  const observed: WorkerFrame[] = [];
  const modelContexts: Array<unknown> = [];
  let modelRequests = 0;
  let toolRequests = 0;
  const result = await probe({
    allowedTools: [todo],
    onFrame: (frame, send) => {
      if (frame.kind === "ready" || frame.kind === "event") {
        send(receipt(frame));
      } else if (frame.kind === "model.request") {
        modelRequests += 1;
        modelContexts.push(frame.context);
        const message = modelRequests === 1
          ? {
              role: "assistant" as const,
              content: [{ type: "toolCall" as const, id: "todo-init", name: "todo", arguments: {
                op: "init", list: [{ phase: "Delivery", items: ["Ship parity slice"] }],
              } }],
              stopReason: "toolUse" as const,
            }
          : modelRequests === 2
            ? {
                role: "assistant" as const,
                content: [{ type: "toolCall" as const, id: "todo-done", name: "todo", arguments: {
                  op: "done", task: "Ship parity slice",
                } }],
                stopReason: "toolUse" as const,
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                stopReason: "stop" as const,
              };
        send({ ...response(frame), kind: "model.end", index: 0, message });
      } else if (frame.kind === "tool.request") {
        toolRequests += 1;
      }
    },
    observed,
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(modelRequests).toBe(3);
  expect(toolRequests).toBe(0);
  expect(modelContexts[0]).toMatchObject({ tools: [todo] });
  expect(modelContexts[1]).toMatchObject({ tools: [todo] });
  expect((modelContexts[1] as { messages: Message[] }).messages.at(-1)).toMatchObject({
    role: "toolResult",
    toolName: "todo",
    details: { phases: [{ name: "Delivery", tasks: [{ content: "Ship parity slice", status: "in_progress" }] }] },
  });
  const todoResults = observed
    .filter((frame) => frame.kind === "event" && frame.event.type === "message_end")
    .map((frame) => frame.kind === "event" && frame.event.type === "message_end" ? frame.event.message : undefined)
    .filter((message): message is Message => message !== undefined)
    .filter((message) => message.role === "toolResult" && message.toolName === "todo");
  expect(todoResults).toHaveLength(2);
  expect(todoResults[0]).toMatchObject({ details: { phases: [{ name: "Delivery" }] } });
  expect(todoResults[1]).toMatchObject({ details: { phases: [{ name: "Delivery", tasks: [{ status: "completed" }] }] } });
  expect(observed.at(-1)).toMatchObject({ kind: "terminal.proposed", outcome: "completed" });
}, 25_000);

test("actual worker rejects an explicitly empty restore transcript", async () => {
  const observed: WorkerFrame[] = [];
  const result = await probe({
    transcript: [],
    onFrame: () => undefined,
    observed,
  });

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("transcript must be a non-empty array");
  expect(observed).toEqual([]);
}, 15_000);

interface ProbeOptions {
  readonly transcript?: readonly Message[];
  readonly allowedTools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: { readonly [key: string]: unknown };
  }[];
  readonly onFrame: (frame: WorkerFrame, send: (frame: HostFrame) => void) => void;
  readonly observed: WorkerFrame[];
  readonly timeoutMs?: number;
}

function receipt(frame: WorkerFrame): Extract<HostFrame, { kind: "receipt" }> {
  return {
    protocol: "anna-omp/1", kind: "receipt", frameId: `ack:${frame.frameId}`,
    requestId: frame.requestId, binding: frame.binding, workerSeq: frame.workerSeq,
    forFrameId: frame.frameId, accepted: true, throughWorkerSeq: frame.workerSeq,
  };
}

function response(frame: WorkerFrame): Pick<HostFrame, "protocol" | "requestId" | "binding" | "workerSeq"> & { frameId: string } {
  return {
    protocol: frame.protocol, frameId: `response:${frame.frameId}`, requestId: frame.requestId,
    binding: frame.binding, workerSeq: frame.workerSeq,
  };
}

async function probe(options: ProbeOptions): Promise<{ code: number | null; stderr: string }> {
  const worker = await launchManagedWorker({ runtimeRoot: runtime, entryPath: join(runtime, "worker.ts"), workspaceRoot: repository });
  let stderr = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const reader = createInterface({ input: worker.child.stdout });
  const send = (frame: HostFrame) => { worker.child.stdin.write(encodeFrame(frame)); };
  worker.child.stdin.on("error", () => undefined);
  worker.child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  try {
    const exited = new Promise<number | null>((resolveExit, reject) => {
      worker.child.once("close", resolveExit);
      worker.child.once("error", reject);
      timeout = setTimeout(() => reject(new Error(`restore probe did not exit: ${stderr}`)), options.timeoutMs ?? 15_000);
      reader.on("line", (line) => {
        try {
          const frame = JSON.parse(line) as WorkerFrame;
          options.observed.push(frame);
          options.onFrame(frame, send);
        } catch (error) { reject(error); }
      });
    });
    send({
      protocol: "anna-omp/1", kind: "start", frameId: "start", requestId: "start", workerSeq: -1,
      binding: { workspaceId: "w", channelId: "c", runId: "r", attemptId: "a", commandId: "cmd", profileHash: "hash" },
      input: {
        systemPrompt: "test", goal: "do not repeat this goal", modelId: "fixture", allowedTools: options.allowedTools ?? [
          { name: "read_only", description: "read", parameters: { type: "object" } },
        ], snapshotDigest: "snapshot", originalExecutionFingerprint: "input",
        ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
      },
    } as unknown as HostFrame);
    return { code: await exited, stderr };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.close();
    await worker.close();
  }
}
