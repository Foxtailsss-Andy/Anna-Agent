import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  createToolGateway,
  type CanonicalEvent,
  type ChannelScope,
  type EventStore,
  type SandboxAdapter,
  type ScopedChannelStore,
  type ToolDefinition,
  type ToolPolicy,
  type ToolRequest,
  type ToolResult,
} from "@anna/harness-v2";

import { InMemoryEventStore, SqliteEventStore } from "../src/index";

const scope = {
  workspaceId: "workspace-tool-gateway",
  channelId: "channel-tool-gateway",
} as ChannelScope;

const boundedPatch: ToolDefinition = {
  name: "bounded_patch",
  replayPolicy: "never",
  inputSchema: {
    parse(input: unknown) {
      return input;
    },
  },
};

const requireApproval: ToolPolicy = {
  async decide() {
    return "require_approval";
  },
};

const succeededResult: ToolResult = {
  status: "succeeded",
  output: { applied: true },
};

interface StoreFixture {
  readonly name: string;
  readonly store: EventStore;
  close(): void;
}

function createToolRequest(runId: string, effectKey: string): ToolRequest {
  return {
    ...scope,
    runId: runId as ToolRequest["runId"],
    workerProfileId: "worker-tool-gateway" as ToolRequest["workerProfileId"],
    name: boundedPatch.name,
    input: { path: "README.md", patch: "approved change" },
    effectKey,
    toolCallId: `tool-call:${runId}:${effectKey}`,
  };
}

function createGateway(events: ScopedChannelStore, sandbox: SandboxAdapter) {
  return createToolGateway({
    catalog: [boundedPatch],
    scope,
    workerProfileId: "worker-tool-gateway" as ToolRequest["workerProfileId"],
    policy: requireApproval,
    sandbox,
    events,
  });
}

async function readAll(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

async function approve(
  events: ScopedChannelStore,
  sandbox: SandboxAdapter,
  request: ToolRequest,
): Promise<void> {
  const gateway = createGateway(events, sandbox);
  const approvalId = `approval:${request.effectKey}`;

  await expect(gateway.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "approval_required", approvalId },
  });
  await gateway.answerApproval({
    ...scope,
    runId: request.runId,
    effectKey: request.effectKey as string,
    approvalId,
    actorId: "human-tool-gateway",
    decision: "approved",
  });
}

function createInMemoryFixture(): StoreFixture {
  return {
    name: "InMemoryEventStore",
    store: new InMemoryEventStore(),
    close() {},
  };
}

function createSqliteFixture(): StoreFixture {
  const directory = mkdtempSync(join(tmpdir(), "anna-tool-gateway-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));

  return {
    name: "SqliteEventStore",
    store,
    close() {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

test("records approved effects through SQLite restart and reuses the completed result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anna-tool-gateway-restart-"));
  const databasePath = join(directory, "events.sqlite");
  const request = createToolRequest("run-sqlite-restart", "effect-sqlite-restart");
  let sandboxExecutions = 0;
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return succeededResult;
    },
  };
  let activeStore: SqliteEventStore | undefined;

  try {
    activeStore = new SqliteEventStore(databasePath);
    const firstScope = activeStore.scope(scope);
    await approve(firstScope, sandbox, request);
    activeStore.close();
    activeStore = undefined;

    activeStore = new SqliteEventStore(databasePath);
    const secondScope = activeStore.scope(scope);
    await expect(
      createGateway(secondScope, sandbox).execute(request, new AbortController().signal),
    ).resolves.toEqual(succeededResult);
    expect(sandboxExecutions).toBe(1);
    activeStore.close();
    activeStore = undefined;

    activeStore = new SqliteEventStore(databasePath);
    const thirdScope = activeStore.scope(scope);
    await expect(
      createGateway(thirdScope, sandbox).execute(request, new AbortController().signal),
    ).resolves.toEqual(succeededResult);
    expect(sandboxExecutions).toBe(1);

    const approvalEvents = await readAll(thirdScope.read(request.runId as never));
    expect(approvalEvents.map((event) => event.seq)).toEqual([0, 1]);
    expect(approvalEvents.map((event) => event.type)).toEqual([
      "tool.approval.requested",
      "tool.approval.answered",
    ]);

    const effectEvents = await readAll(
      thirdScope.read(`effect:${request.effectKey}` as never),
    );
    expect(effectEvents.map((event) => event.seq)).toEqual([0, 1]);
    expect(effectEvents.map((event) => event.type)).toEqual([
      "tool.effect.started",
      "tool.effect.succeeded",
    ]);
  } finally {
    activeStore?.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

for (const createFixture of [createInMemoryFixture, createSqliteFixture]) {
  test(`${createFixture.name} executes each approved duplicate effect key once`, async () => {
    const fixture = createFixture();

    try {
      const events = fixture.store.scope(scope);

      for (const duplicateCount of [1, 2, 5, 20]) {
        const request = createToolRequest(
          `run-duplicates-${duplicateCount}`,
          `effect-duplicates-${duplicateCount}`,
        );
        let sandboxExecutions = 0;
        const sandbox: SandboxAdapter = {
          async execute() {
            sandboxExecutions += 1;
            return succeededResult;
          },
        };

        await approve(events, sandbox, request);

        const results: ToolResult[] = [];
        for (let duplicate = 0; duplicate < duplicateCount; duplicate += 1) {
          results.push(
            await createGateway(events, sandbox).execute(
              request,
              new AbortController().signal,
            ),
          );
        }

        expect(results).toEqual(
          Array.from({ length: duplicateCount }, () => succeededResult),
        );
        expect(sandboxExecutions).toBe(1);
      }
    } finally {
      fixture.close();
    }
  });
}
