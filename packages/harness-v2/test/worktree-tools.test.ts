import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import * as harnessPublicApi from "../src/index";
import {
  createToolGateway,
  parseCanonicalEvent,
  type CanonicalEvent,
  type SandboxAdapter,
  type ScopedChannelStore,
  type ToolDefinition,
  type ToolPolicy,
  type ToolRequest,
} from "../src/index";

interface ExpectedWorktreeToolsPublicApi {
  createLocalPreviewWorktreeSandbox(options: {
    approvedWorktreeRoot: string;
    maxReadBytes?: number;
    maxPatchBytes?: number;
  }): SandboxAdapter;
  createLocalPreviewWorktreeToolCatalog(): readonly ToolDefinition[];
}

const expectedWorktreeToolsPublicApi =
  harnessPublicApi as unknown as ExpectedWorktreeToolsPublicApi;

const gatewayScope = Object.freeze({
  workspaceId: "workspace-1" as ToolRequest["workspaceId"],
  channelId: "channel-1" as ToolRequest["channelId"],
});
const gatewayWorkerProfileId = "worker-profile-1" as ToolRequest["workerProfileId"];

function createRequest(
  name: ToolRequest["name"],
  input: ToolRequest["input"],
  effectKey?: string,
): ToolRequest {
  return {
    name,
    input,
    ...(effectKey === undefined ? {} : { effectKey }),
    workspaceId: gatewayScope.workspaceId,
    channelId: gatewayScope.channelId,
    runId: "run-1" as never,
    workerProfileId: gatewayWorkerProfileId,
    toolCallId: `tool-call:${name}:${effectKey ?? "read"}`,
  };
}

function createDurableEvents(): Pick<ScopedChannelStore, "append" | "read"> {
  const eventsByStream = new Map<string, CanonicalEvent[]>();

  return {
    async append(event) {
      const canonicalEvent = parseCanonicalEvent(event);
      const events = eventsByStream.get(canonicalEvent.streamId) ?? [];
      events.push(canonicalEvent);
      eventsByStream.set(canonicalEvent.streamId, events);
    },
    async *read(streamId, afterSeq) {
      for (const event of eventsByStream.get(streamId) ?? []) {
        if (afterSeq === undefined || event.seq > afterSeq) {
          yield event;
        }
      }
    },
  };
}

test("local preview Sandbox confines workspace tools to the approved worktree", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "anna-harness-v2-worktree-tools-"),
  );

  try {
    const approvedWorktreeRoot = join(temporaryRoot, "approved-worktree");
    const outsideRoot = join(temporaryRoot, "outside");
    const outsideSecret = join(outsideRoot, "secret.txt");
    const outsideTarget = join(outsideRoot, "target.txt");
    const outsideDirectoryLink = join(
      approvedWorktreeRoot,
      "outside-directory-link",
    );
    const outsideTargetLink = join(
      approvedWorktreeRoot,
      "outside-target-link.txt",
    );
    const secretContents = "outside-secret-content-must-not-leak";
    const targetContents = Buffer.from("outside target before\n", "utf8");

    await Promise.all([mkdir(approvedWorktreeRoot), mkdir(outsideRoot)]);
    await Promise.all([
      writeFile(outsideSecret, secretContents),
      writeFile(outsideTarget, targetContents),
    ]);
    await symlink(outsideRoot, outsideDirectoryLink, "dir");
    await symlink(outsideTarget, outsideTargetLink, "file");

    const sandbox =
      expectedWorktreeToolsPublicApi.createLocalPreviewWorktreeSandbox({
        approvedWorktreeRoot,
      });
    const signal = new AbortController().signal;
    const rejectedRequests = [
      createRequest(
        "read_workspace",
        { path: "../outside/secret.txt" },
        "read-parent-escape",
      ),
      createRequest(
        "read_workspace",
        { path: "outside-directory-link/secret.txt" },
        "read-symlink-escape",
      ),
      createRequest(
        "bounded_patch",
        {
          path: "../outside/target.txt",
          patch: "@@ -1 +1 @@\n-outside target before\n+outside target after\n",
        },
        "patch-parent-escape",
      ),
      createRequest(
        "bounded_patch",
        {
          path: "outside-target-link.txt",
          patch: "@@ -1 +1 @@\n-outside target before\n+outside target after\n",
        },
        "patch-symlink-escape",
      ),
    ];

    for (const request of rejectedRequests) {
      await expect(sandbox.execute(request, signal)).resolves.toEqual({
        status: "failed",
        output: { reason: "path_outside_approved_worktree" },
      });
    }

    expect(await readFile(outsideTarget)).toEqual(targetContents);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("local preview Sandbox returns bounded content from the approved worktree", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "anna-harness-v2-worktree-tools-"),
  );

  try {
    const approvedWorktreeRoot = join(temporaryRoot, "approved-worktree");
    const documentPath = join(approvedWorktreeRoot, "docs", "README.md");
    const documentContents = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    await mkdir(join(approvedWorktreeRoot, "docs"), { recursive: true });
    await writeFile(documentPath, documentContents);

    const sandbox =
      expectedWorktreeToolsPublicApi.createLocalPreviewWorktreeSandbox({
        approvedWorktreeRoot,
        maxReadBytes: 12,
      });
    const result = await sandbox.execute(
      createRequest("read_workspace", { path: "docs/README.md" }),
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: "succeeded",
      output: {
        path: "docs/README.md",
        content: "0123456789AB",
        truncated: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(approvedWorktreeRoot);
    expect(await readFile(documentPath, "utf8")).toBe(documentContents);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("local preview Sandbox applies a bounded literal replacement to one approved worktree file", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "anna-harness-v2-worktree-tools-"),
  );

  try {
    const approvedWorktreeRoot = join(temporaryRoot, "approved-worktree");
    const relativePath = "src/example.txt";
    const documentPath = join(approvedWorktreeRoot, relativePath);
    const beforeContents = "alpha\nbefore\nomega\n";
    const afterContents = "alpha\nafter\nomega\n";

    await mkdir(join(approvedWorktreeRoot, "src"), { recursive: true });
    await writeFile(documentPath, beforeContents);

    const sandbox =
      expectedWorktreeToolsPublicApi.createLocalPreviewWorktreeSandbox({
        approvedWorktreeRoot,
        maxPatchBytes: 64,
      });
    const result = await sandbox.execute(
      createRequest(
        "bounded_patch",
        {
          path: relativePath,
          expected: "before",
          replacement: "after",
        },
        "bounded-literal-replacement",
      ),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        path: relativePath,
        changedFiles: [relativePath],
        beforeHash: `sha256:${createHash("sha256")
          .update(beforeContents, "utf8")
          .digest("hex")}`,
        afterHash: `sha256:${createHash("sha256")
          .update(afterContents, "utf8")
          .digest("hex")}`,
      },
    });
    expect(await readFile(documentPath, "utf8")).toBe(afterContents);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("public Gateway runs approved local worktree tools through durable approval and replay", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "anna-harness-v2-worktree-gateway-"),
  );

  try {
    const approvedWorktreeRoot = join(temporaryRoot, "approved-worktree");
    const relativePath = "src/example.txt";
    const documentPath = join(approvedWorktreeRoot, relativePath);
    const beforeContents = "alpha\nbefore\nomega\n";
    const afterContents = "alpha\nafter\nomega\n";
    await mkdir(join(approvedWorktreeRoot, "src"), { recursive: true });
    await writeFile(documentPath, beforeContents);

    expect(
      typeof expectedWorktreeToolsPublicApi.createLocalPreviewWorktreeToolCatalog,
    ).toBe("function");
    const catalog =
      expectedWorktreeToolsPublicApi.createLocalPreviewWorktreeToolCatalog();
    expect(
      catalog.map(({ name, replayPolicy }) => ({ name, replayPolicy })),
    ).toEqual([
      { name: "read_workspace", replayPolicy: "safe" },
      { name: "bounded_patch", replayPolicy: "never" },
    ]);

    const sandboxExecutions: ToolRequest[] = [];
    const localPreviewSandbox =
      expectedWorktreeToolsPublicApi.createLocalPreviewWorktreeSandbox({
        approvedWorktreeRoot,
      });
    const sandbox: SandboxAdapter = {
      async execute(request, signal) {
        sandboxExecutions.push(request);
        return localPreviewSandbox.execute(request, signal);
      },
    };
    const events = createDurableEvents();
    const policy: ToolPolicy = {
      async decide(request) {
        if (request.name === "read_workspace") {
          return "allow";
        }

        return request.name === "bounded_patch" ? "require_approval" : "deny";
      },
    };
    let nextEventId = 0;
    const gatewayOptions = {
      catalog,
      scope: gatewayScope,
      workerProfileId: gatewayWorkerProfileId,
      policy,
      sandbox,
      events,
      createEventId: () => `event-${nextEventId++}`,
      now: () => "2026-08-19T00:00:00.000Z",
    };
    const signal = new AbortController().signal;
    const readRequest = createRequest("read_workspace", { path: relativePath });
    const patchRequest = createRequest(
      "bounded_patch",
      {
        path: relativePath,
        expected: "before",
        replacement: "after",
      },
      "bounded-patch-effect-1",
    );

    const gatewayBeforeApproval = createToolGateway(gatewayOptions);
    await expect(gatewayBeforeApproval.execute(readRequest, signal)).resolves.toEqual({
      status: "succeeded",
      output: {
        path: relativePath,
        content: beforeContents,
        truncated: false,
      },
    });
    expect(await readFile(documentPath, "utf8")).toBe(beforeContents);
    expect(sandboxExecutions.map((request) => request.name)).toEqual([
      "read_workspace",
    ]);

    await expect(gatewayBeforeApproval.execute(patchRequest, signal)).resolves.toEqual({
      status: "failed",
      output: {
        reason: "approval_required",
        approvalId: "approval:bounded-patch-effect-1",
      },
    });
    expect(await readFile(documentPath, "utf8")).toBe(beforeContents);
    expect(sandboxExecutions).toHaveLength(1);

    await gatewayBeforeApproval.answerApproval({
      workspaceId: patchRequest.workspaceId,
      channelId: patchRequest.channelId,
      runId: patchRequest.runId,
      effectKey: "bounded-patch-effect-1",
      approvalId: "approval:bounded-patch-effect-1",
      actorId: "human-1",
      decision: "approved",
    });

    const gatewayAfterApproval = createToolGateway(gatewayOptions);
    const patchResult = await gatewayAfterApproval.execute(patchRequest, signal);
    expect(patchResult).toMatchObject({
      status: "succeeded",
      output: {
        path: relativePath,
        changedFiles: [relativePath],
      },
    });
    expect(await readFile(documentPath, "utf8")).toBe(afterContents);

    const gatewayReplay = createToolGateway(gatewayOptions);
    await expect(gatewayReplay.execute(patchRequest, signal)).resolves.toEqual(
      patchResult,
    );
    expect(await readFile(documentPath, "utf8")).toBe(afterContents);
    expect(sandboxExecutions.map((request) => request.name)).toEqual([
      "read_workspace",
      "bounded_patch",
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
