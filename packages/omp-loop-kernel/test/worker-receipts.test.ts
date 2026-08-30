import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, test } from "vitest";
import { launchManagedWorker } from "../src/managed-launcher";
import { encodeFrame, type HostFrame, type WorkerFrame } from "../src/protocol";

const repository = resolve(import.meta.dirname, "../../..");
let root: string;
let runtime: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "anna-omp-receipts-"));
  runtime = join(root, "runtime");
  await cp(join(repository, "build/omp-runtime/darwin-arm64"), runtime, { recursive: true });
  for (const file of ["worker.ts", "protocol.ts"]) {
    await cp(join(repository, "packages/omp-loop-kernel/runtime", file), join(runtime, file));
  }
}, 30_000);

afterAll(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); });

test.each(["requestId", "workerSeq", "throughWorkerSeq"] as const)(
  "actual worker rejects a ready ACK with mismatched %s before model/tool dispatch",
  async (field) => {
    const result = await probe((frame, send) => {
      if (frame.kind !== "ready") return;
      const ack = receipt(frame);
      send({ ...ack, [field]: field === "requestId" ? "wrong-request" : 1 });
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("receipt correlation mismatch");
    expect(result.frames.map((frame) => frame.kind)).toEqual(["ready"]);
  },
  15_000,
);

test("actual worker completes and exits normally with identical duplicate ACKs", async () => {
  const result = await probe((frame, send) => {
    if (frame.kind === "ready" || frame.kind === "event") {
      const ack = receipt(frame);
      send(ack);
      send(ack);
    } else if (frame.kind === "model.request") {
      send({
        protocol: frame.protocol, kind: "model.end", frameId: "answer", requestId: frame.requestId,
        binding: frame.binding, workerSeq: frame.workerSeq, index: 0,
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      });
    }
  });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.frames.filter((frame) => frame.kind === "model.request")).toHaveLength(1);
  expect(result.frames.at(-1)).toMatchObject({ kind: "terminal.proposed", outcome: "completed" });
}, 15_000);

test("actual worker rejects a changed duplicate event ACK", async () => {
  const result = await probe((frame, send) => {
    if (frame.kind === "ready") send(receipt(frame));
    else if (frame.kind === "event") {
      const ack = receipt(frame);
      send(ack);
      send({ ...ack, frameId: "changed-ack-id" });
    }
  });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("changed duplicate OMP receipt");
  expect(result.frames.some((frame) => frame.kind === "event")).toBe(true);
  expect(result.frames.some((frame) => frame.kind === "tool.request" || frame.kind === "terminal.proposed")).toBe(false);
}, 15_000);

test("actual worker expires an unacknowledged ready receipt without model/tool dispatch", async () => {
  let readyAt = 0;
  const result = await probe((frame) => { if (frame.kind === "ready") readyAt = Date.now(); });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("receipt deadline exceeded");
  expect(readyAt).toBeGreaterThan(0);
  expect(Date.now() - readyAt).toBeGreaterThanOrEqual(9_900);
  expect(Date.now() - readyAt).toBeLessThan(14_000);
  expect(result.frames.map((frame) => frame.kind)).toEqual(["ready"]);
}, 20_000);

function receipt(frame: WorkerFrame): Extract<HostFrame, { kind: "receipt" }> {
  return {
    protocol: "anna-omp/1", kind: "receipt", frameId: `ack:${frame.frameId}`,
    requestId: frame.requestId, binding: frame.binding, workerSeq: frame.workerSeq,
    forFrameId: frame.frameId, accepted: true, throughWorkerSeq: frame.workerSeq,
  };
}

async function probe(onFrame: (frame: WorkerFrame, send: (frame: HostFrame) => void) => void) {
  const worker = await launchManagedWorker({ runtimeRoot: runtime, entryPath: join(runtime, "worker.ts"), workspaceRoot: repository });
  const frames: WorkerFrame[] = [];
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
      timeout = setTimeout(() => reject(new Error(`receipt probe did not exit: ${stderr}`)), 15_000);
      reader.on("line", (line) => {
        try {
          const frame = JSON.parse(line) as WorkerFrame;
          frames.push(frame);
          onFrame(frame, send);
        } catch (error) { reject(error); }
      });
    });
    send({
      protocol: "anna-omp/1", kind: "start", frameId: "start", requestId: "start", workerSeq: -1,
      binding: { workspaceId: "w", channelId: "c", runId: "r", attemptId: "a", commandId: "cmd", profileHash: "hash" },
      input: { systemPrompt: "test", goal: "task", modelId: "fixture", allowedTools: [], snapshotDigest: "snapshot", originalExecutionFingerprint: "input" },
    });
    return { code: await exited, stderr, frames };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.close();
    await worker.close();
  }
}
