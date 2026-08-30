import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runManagedOmpWorker } from "../src/worker-client";

test("client sends abort and allows cooperative process exit before terminating", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-omp-abort-protocol-"));
  const runtime = join(root, "runtime");
  const controller = new AbortController();
  let diagnostics = "";
  try {
    await mkdir(runtime);
    await copyFile(resolve(import.meta.dirname, "../../../build/omp-runtime/darwin-arm64/bun"), join(runtime, "bun"));
    const entry = join(runtime, "probe.ts");
    await writeFile(entry, `
      import {createInterface} from "node:readline";
      const reader = createInterface({input:process.stdin});
      let start;
      reader.on("line", line => {
        const frame = JSON.parse(line);
        if(frame.kind === "start") {
          start = frame;
          console.log(JSON.stringify({protocol:frame.protocol,kind:"ready",frameId:"ready",requestId:frame.requestId,binding:frame.binding,workerSeq:0,runtime:{bunVersion:Bun.version,ompVersion:"18.0.11",activeTools:[]}}));
        } else if(frame.kind === "receipt" && frame.forFrameId === "ready") {
          console.log(JSON.stringify({protocol:start.protocol,kind:"event",frameId:"user",requestId:"user",binding:start.binding,workerSeq:1,event:{type:"message_end",message:{role:"user",content:"task"}}}));
        } else if(frame.kind === "receipt" && frame.forFrameId === "user") {
          console.log(JSON.stringify({protocol:start.protocol,kind:"model.request",frameId:"model",requestId:"model",binding:start.binding,workerSeq:2,modelId:"fixture",context:{systemPrompt:"test",messages:[{role:"user",content:"task"}]}}));
        } else if(frame.kind === "abort") {
          process.stderr.write("cooperative-abort\\n");
          reader.close(); process.stdin.destroy();
        }
      });
    `);
    await expect(runManagedOmpWorker({ runtimeRoot: runtime, entryPath: entry, workspaceRoot: root,
      binding: {workspaceId:"w",channelId:"c",runId:"r",attemptId:"a",commandId:"cmd",profileHash:"hash"},
      input: {systemPrompt:"test",goal:"task",modelId:"fixture",allowedTools:[],snapshotDigest:"snapshot",originalExecutionFingerprint:"input"},
      signal: controller.signal, onDiagnostic: text => { diagnostics += text; },
      modelTransport: async function* () { controller.abort(); },
      toolGateway: async () => { throw new Error("no tools expected"); },
    })).rejects.toThrow("cancelled");
    expect(diagnostics).toContain("cooperative-abort");
    expect(await readFile(entry, "utf8")).toContain("cooperative-abort");
  } finally { await rm(root, {recursive:true,force:true}); }
}, 15_000);
