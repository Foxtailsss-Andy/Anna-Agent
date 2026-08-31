import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runManagedOmpWorker } from "../src/worker-client";

// These adversarial pipe peers test the client boundary, not actual SDK execution.
test.each(["scope", "attempt", "sequence", "undeclared-tool", "early-terminal", "oversized", "malformed"])(
  "rejects %s protocol input before any model or tool dispatch", async mode => {
    const root = await mkdtemp(join(tmpdir(), "anna-omp-protocol-negative-"));
    let models = 0;
    let tools = 0;
    try {
      const runtime = join(root, "runtime");
      await mkdir(runtime);
      await copyFile(resolve(import.meta.dirname, "../../../build/omp-runtime/darwin-arm64/bun"), join(runtime, "bun"));
      const entry = join(runtime, "peer.ts");
      await writeFile(entry, `
        import {createInterface} from "node:readline";
        const reader=createInterface({input:process.stdin}); let start;
        reader.on("line", line=>{
          const frame=JSON.parse(line);
          if(frame.kind==="abort"){reader.close();process.stdin.destroy();return;}
          if(frame.kind==="start"){
            start=frame;
            console.log(JSON.stringify({protocol:frame.protocol,kind:"ready",frameId:"ready",requestId:frame.requestId,binding:frame.binding,workerSeq:0,runtime:{bunVersion:Bun.version,ompVersion:"18.0.11",activeTools:[]}}));
          }else if(frame.kind==="receipt"){
            const mode=${JSON.stringify(mode)};
            if(mode==="malformed"){console.log("{invalid");return;}
            if(mode==="oversized"){console.log("x".repeat(1024*1024+1));return;}
            const next={protocol:start.protocol,kind:"model.request",frameId:"request",requestId:"request",binding:{...start.binding},workerSeq:1,modelId:"fixture",context:{systemPrompt:"test",messages:[{role:"user",content:"task"}]}};
            if(mode==="scope")next.binding.channelId="other";
            if(mode==="attempt")next.binding.attemptId="old";
            if(mode==="sequence")next.workerSeq=3;
            if(mode==="undeclared-tool"){delete next.modelId;delete next.context;Object.assign(next,{kind:"tool.request",toolCallId:"unrequested",name:"shell",input:{}});}
            if(mode==="early-terminal"){delete next.modelId;delete next.context;Object.assign(next,{kind:"terminal.proposed",outcome:"completed"});}
            console.log(JSON.stringify(next));
          }
        });
      `);
      await expect(runManagedOmpWorker({ runtimeRoot: runtime, entryPath: entry, workspaceRoot: root,
        binding: {workspaceId:"w",channelId:"c",runId:"r",attemptId:"a",commandId:"cmd",profileHash:"hash"},
        input: {systemPrompt:"test",goal:"task",modelId:"fixture",allowedTools:[],snapshotDigest:"snapshot",originalExecutionFingerprint:"input"},
        modelTransport: async function* () { models += 1; },
        toolGateway: async () => { tools += 1; return {status:"failed"}; },
      })).rejects.toThrow();
      expect(models).toBe(0);
      expect(tools).toBe(0);
    } finally { await rm(root, {recursive:true,force:true}); }
  }, 15_000,
);

test.each(["tool", "terminal"])("rejects %s before its model observation is durable", async mode => {
  const root = await mkdtemp(join(tmpdir(), "anna-omp-missing-observation-"));
  let tools = 0;
  try {
    await mkdir(join(root, "workspace"));
    await copyFile(resolve(import.meta.dirname, "../../../build/omp-runtime/darwin-arm64/bun"), join(root, "bun"));
    const entry = join(root, "peer.ts");
    await writeFile(entry, `
      import {createInterface} from "node:readline";
      const reader=createInterface({input:process.stdin});let start;
      const send=(kind,seq,payload)=>console.log(JSON.stringify({protocol:start.protocol,kind,frameId:"f"+seq,requestId:"q"+seq,binding:start.binding,workerSeq:seq,...payload}));
      reader.on("line",line=>{
        const f=JSON.parse(line);
        if(f.kind==="abort"){reader.close();process.stdin.destroy();return;}
        if(f.kind==="start"){start=f;console.log(JSON.stringify({protocol:f.protocol,kind:"ready",frameId:"ready",requestId:f.requestId,binding:f.binding,workerSeq:0,runtime:{bunVersion:Bun.version,ompVersion:"18.0.11",activeTools:["read_only"]}}));}
        else if(f.kind==="receipt"&&f.forFrameId==="ready")send("event",1,{event:{type:"message_end",message:{role:"user",content:"task"}}});
        else if(f.kind==="receipt"&&f.forFrameId==="f1")send("model.request",2,{modelId:"fixture",context:{systemPrompt:"test",messages:[{role:"user",content:"task"}]}});
        else if(f.kind==="model.end"){
          if(${JSON.stringify(mode)}==="tool")send("tool.request",3,{toolCallId:"read",name:"read_only",input:{path:"a"}});
          else send("terminal.proposed",3,{outcome:"completed"});
        }
      });
    `);
    await expect(runManagedOmpWorker({runtimeRoot:root,entryPath:entry,workspaceRoot:join(root,"workspace"),
      binding:{workspaceId:"w",channelId:"c",runId:"r",attemptId:"a",commandId:"cmd",profileHash:"hash"},
      input:{systemPrompt:"test",goal:"task",modelId:"fixture",allowedTools:[{name:"read_only",description:"read",parameters:{type:"object"}}],snapshotDigest:"snapshot",originalExecutionFingerprint:"input"},
      modelTransport:async function*(){yield {deltas:[],message:mode==="tool"?{role:"assistant",content:[{type:"toolCall",id:"read",name:"read_only",arguments:{path:"a"}}],stopReason:"toolUse"}:{role:"assistant",content:[{type:"text",text:"done"}],stopReason:"stop"}};},
      toolGateway:async()=>{tools++;return {status:"succeeded"};},
    })).rejects.toThrow("durable");
    expect(tools).toBe(0);
  } finally {await rm(root,{recursive:true,force:true});}
},15_000);
