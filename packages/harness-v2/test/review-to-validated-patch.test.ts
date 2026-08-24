import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { expect, test } from "vitest";

import { InMemoryEventStore, SqliteEventStore } from "@anna/event-store";
import { evaluateContract } from "@anna/eval";
import { projectTrace } from "@anna/trace";

import {
  createDeterministicReviewFixture,
  createReviewToValidatedPatch,
  assertT07LivePlatform,
  digestFilesForTest,
  hashBytesForTest,
  ReviewUnsupportedPlatformError,
  type CanonicalEvent,
  type ReviewArtifact,
  type ReviewApprovalProvider,
  type ReviewScenarioServices,
  type ReviewScenarioInput,
  type ScheduleRecord,
  type ScopedChannelStore,
  type StreamId,
  parseArtifact,
  parseStartRun,
  parseSchedule,
} from "../src/index";

const execFile = promisify(execFileCallback);

function stripAnsiFromVitestEvidence(value: string): string {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

test("ANSI formatting does not hide live Vitest pass counts", () => {
  expect(stripAnsiFromVitestEvidence("Tests \u001b[32m 2 passed\u001b[39m")).toMatch(/Tests\s+2 passed/);
});

async function initializeTestRepository(root: string, scenarioInput: ReviewScenarioInput): Promise<void> {
  await execFile("git", ["init", "--quiet", root]);
  await execFile("git", ["-C", root, "config", "user.email", "t07@example.invalid"]);
  await execFile("git", ["-C", root, "config", "user.name", "Anna T07 Test"]);
  await execFile("git", [
    "-C",
    root,
    "add",
    scenarioInput.prdPath,
    scenarioInput.uiPath,
    "package.json",
    ...(scenarioInput.testPath === undefined ? [] : [scenarioInput.testPath]),
  ]);
  await execFile("git", ["-C", root, "commit", "--quiet", "-m", "test baseline"]);
}

const input: ReviewScenarioInput = {
  workspaceId: "workspace-review",
  channelId: "channel-review",
  reviewNotes: "Compact the approval panel and keep the owner decision visible.",
  prdPath: "docs/review-prd.md",
  uiPath: "src/review-panel.tsx",
  ownerId: "actor-owner",
  sourceRunId: "run-review-source",
  sourceEventIds: ["event-review-source"],
};

const ownerApproval: ReviewApprovalProvider = {
  confirmMemoryCandidate: async () => ({ approved: true, actorId: input.ownerId }),
  approveLane: async () => ({ approved: true, actorId: input.ownerId }),
  approveEffect: async () => ({ approved: true, actorId: input.ownerId }),
};

function reviewServices(
  scenarioInput: ReviewScenarioInput,
  events: Pick<ScopedChannelStore, "append" | "appendIdempotent" | "read" | "listRunStreamIds">,
  memory: { proposed: string[]; accepted: string[] } = { proposed: [], accepted: [] },
): ReviewScenarioServices {
  return {
    events,
    memory: {
      async propose(candidate) {
        memory.proposed.push(candidate.id);
      },
      async accept(candidate) {
        memory.accepted.push(candidate.candidateId);
      },
    },
    traceProjector: {
      project(canonicalEvents, traceId) {
        const document = projectTrace(canonicalEvents, {
          runId: traceId,
          surface: "t07-review",
          scope: {
            workspaceId: scenarioInput.workspaceId as never,
            channelId: scenarioInput.channelId as never,
          },
        });
        const artifactIds = canonicalEvents
          .filter((event) => event.type === "t07.artifact.recorded")
          .flatMap((event) => {
            const payload = event.payload as { artifact?: { id?: unknown } };
            return typeof payload.artifact?.id === "string" ? [payload.artifact.id] : [];
          });
        const gateIds = canonicalEvents
          .filter((event) => event.type === "t07.gate.recorded")
          .flatMap((event) => {
            const payload = event.payload as { gate?: { id?: unknown } };
            return typeof payload.gate?.id === "string" ? [payload.gate.id] : [];
          });
        return {
          traceId: document.trace_id,
          artifactIds,
          gateIds,
          eventIds: canonicalEvents.map((event) => event.id),
        };
      },
    },
    evalGate: {
      async evaluate(evidence) {
        const contract = evaluateContract({
          traceId: evidence.traceId,
          events: evidence.events,
          artifacts: evidence.artifacts.map((artifact: ReviewArtifact) => ({
            id: artifact.id as never,
            workspaceId: scenarioInput.workspaceId as never,
            channelId: scenarioInput.channelId as never,
            runId: artifact.producerRunId as never,
            kind: artifact.kind,
            uri: artifact.path,
            hash: artifact.hash,
            version: artifact.version,
            validationStatus: artifact.validationStatus,
            reviewState: artifact.reviewState,
          })),
        }, {
          requiredEventTypes: ["run.started", "t07.test.executed"],
          requiredArtifactKinds: ["test"],
          requireTerminal: false,
        });
        return {
          passed: evidence.testsPassed && contract.passed,
          reason: contract.reason,
          checkedEventIds: contract.checkedEventIds,
        };
      },
    },
  };
}

function scenarioOptions(
  root: string,
  scenarioInput: ReviewScenarioInput = input,
  events = new InMemoryEventStore().scope({
    workspaceId: scenarioInput.workspaceId as never,
    channelId: scenarioInput.channelId as never,
  }),
) {
  const scheduled: ScheduleRecord[] = [];
  const proposed: string[] = [];
  const accepted: string[] = [];
  return {
    scheduled,
    proposed,
    accepted,
    events,
    options: {
      root,
      input: scenarioInput,
      services: reviewServices(scenarioInput, events, { proposed, accepted }),
      scheduler: {
        async schedule(record: ScheduleRecord) {
          scheduled.push(record);
          return record;
        },
      },
      approvalProvider: ownerApproval,
    },
  };
}

async function withScenario<T>(callback: (
  scenario: ReturnType<typeof createReviewToValidatedPatch>,
  events: Pick<ScopedChannelStore, "append" | "appendIdempotent" | "read" | "listRunStreamIds">,
  root: string,
) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "anna-t07-review-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, input.prdPath), "# Review PRD\n\n- Keep owner decision visible.\n");
    await writeFile(join(root, input.uiPath), [
      'import { createRoot } from "react-dom/client";',
      'const panel = "before";',
      'createRoot(document.getElementById("root")!).render(<main data-review-panel="true">{panel}</main>);',
      "",
    ].join("\n"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"console.log('t07-test-ok')\"" },
    }));
    await initializeTestRepository(root, input);
    const configured = scenarioOptions(root);
    return await callback(createReviewToValidatedPatch(configured.options), configured.events, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("fixture commands use the active npm CLI path", async () => {
  const npmFixtureRoot = await mkdtemp(join(tmpdir(), "anna-t07-npm-cli-"));
  const npmCliPath = join(npmFixtureRoot, "bin", "npm-cli.cjs");
  const previousNpmExecPath = process.env.npm_execpath;
  try {
    await mkdir(dirname(npmCliPath), { recursive: true });
    await writeFile(npmCliPath, [
      'const { readFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      'if (process.argv[2] !== "test") process.exit(64);',
      'process.stdout.write("active-npm-cli\\n");',
      'const script = JSON.parse(readFileSync("package.json", "utf8")).scripts.test;',
      'const result = spawnSync("/bin/sh", ["-c", script], { stdio: "inherit", env: process.env });',
      'process.exit(result.status ?? 1);',
      "",
    ].join("\n"));
    process.env.npm_execpath = npmCliPath;

    await withScenario(async (scenario) => {
      const prepared = await scenario.prepare();
      const [prdLane, uiLane] = await Promise.all([
        scenario.runPrdLane(prepared),
        scenario.runUiLane(prepared),
      ]);
      await scenario.approve(prdLane.id, input.ownerId);
      await scenario.approve(uiLane.id, input.ownerId);
      const development = await scenario.startDevelopment(prepared);

      const result = await scenario.runTests(development);

      expect(result.passed).toBe(true);
      expect(result.evidence.stdout).toContain("active-npm-cli");
      expect(result.evidence.stdout).toContain("t07-test-ok");
    });
  } finally {
    if (previousNpmExecPath === undefined) {
      delete process.env.npm_execpath;
    } else {
      process.env.npm_execpath = previousNpmExecPath;
    }
    await rm(npmFixtureRoot, { recursive: true, force: true });
  }
});

test("does not start development before PRD and UI approval", async () => {
  await withScenario(async (scenario) => {
    const prepared = await scenario.prepare();

    await expect(scenario.startDevelopment(prepared)).rejects.toThrow("approval");
  });
});

test("boolean-only or wrong-actor approval is not accepted as evidence", async () => {
  await withScenario(async (_scenario, events, root) => {
    const malformed = {
      ...ownerApproval,
      async confirmMemoryCandidate() {
        return true;
      },
    } as unknown as ReviewApprovalProvider;
    const configured = scenarioOptions(root, input, events as never);
    const rejected = createReviewToValidatedPatch({
      ...configured.options,
      approvalProvider: malformed,
    });

    const traceId = (await rejected.prepare()).traceId;
    await expect(rejected.run()).rejects.toThrow(/approval decision|actorId/i);
    const recorded: CanonicalEvent[] = [];
    for await (const event of events.read(traceId as never)) recorded.push(event);
    expect(recorded.some((event) => event.type === "t07.rework.awaiting_approval")).toBe(true);
    expect(recorded.some((event) => event.type === "run.failed")).toBe(false);
  });
});

test("owner request-rework stays resumable on the same Trace", async () => {
  await withScenario(async (_scenario, events, root) => {
    let requestRework = true;
    const configured = scenarioOptions(root, input, events as never);
    const resumable = createReviewToValidatedPatch({
      ...configured.options,
      approvalProvider: {
        ...ownerApproval,
        async approveLane(lane) {
          if (lane.lane === "ui" && requestRework) {
            return { approved: false, actorId: input.ownerId };
          }
          return { approved: true, actorId: input.ownerId };
        },
      },
    });
    await expect(resumable.run()).rejects.toThrow(/rework|approval/i);
    const traceId = (await resumable.prepare()).traceId;
    const firstEvents: CanonicalEvent[] = [];
    for await (const event of events.read(traceId as never)) firstEvents.push(event);
    expect(firstEvents.some((event) => event.type === "t07.rework.awaiting_approval")).toBe(true);
    expect(firstEvents.some((event) => event.type === "run.failed")).toBe(false);

    requestRework = false;
    const result = await resumable.run();
    expect(result.traceId).toBe(traceId);
    expect(result.mergeReady).toBe(true);
  });
});

test("run.started persists a parseable resolved RunProfile contract", async () => {
  await withScenario(async (scenario, events) => {
    const result = await scenario.run();
    const recorded: CanonicalEvent[] = [];
    for await (const event of events.read(result.traceId as never)) recorded.push(event);
    const started = recorded.find((event) => event.type === "run.started");
    expect(started).toBeDefined();
    const payload = started!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      runId: result.traceId,
      budget: expect.any(Object),
      permissionScope: expect.any(String),
      stopCondition: "artifact_or_terminal",
    });
    expect(() => parseStartRun({
      commandId: "command:t07-test",
      runId: result.traceId,
      goal: "Review notes to validated patch",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      source: { eventId: input.sourceEventIds[0] },
      runProfile: payload.runProfile,
      runProfileSnapshot: payload.runProfileSnapshot,
      budget: payload.budget,
      permissionScope: payload.permissionScope,
      stopCondition: payload.stopCondition,
    })).not.toThrow();
  });
});

test("parallel Lane proposals do not mutate shared facts before the human merge", async () => {
  await withScenario(async (scenario) => {
    const prepared = await scenario.prepare();
    const before = await readFile(prepared.paths.prd, "utf8");

    const [prdLane, uiLane] = await Promise.all([
      scenario.runPrdLane(prepared),
      scenario.runUiLane(prepared),
    ]);

    expect(prdLane.kind).toBe("proposal");
    expect(uiLane.kind).toBe("artifact");
    await expect(readFile(prepared.paths.prd, "utf8")).resolves.toBe(before);
    await expect(scenario.approve(prdLane.id, input.ownerId)).resolves.toBeDefined();
    await expect(scenario.approve(uiLane.id, input.ownerId)).resolves.toBeDefined();
  });
});

test("worktree mutation cannot escape its disposable root", async () => {
  await withScenario(async (scenario) => {
    const prepared = await scenario.prepare();

    await expect(scenario.readWorkspace(prepared, "../outside.txt")).resolves.toMatchObject({
      status: "failed",
      output: { reason: "path_outside_approved_worktree" },
    });
  });
});

test.skipIf(process.platform !== "darwin")("approved test processes cannot write outside the disposable worktree", async () => {
  await withScenario(async (scenario) => {
    const prepared = await scenario.prepare();
    const [prdLane, uiLane] = await Promise.all([
      scenario.runPrdLane(prepared),
      scenario.runUiLane(prepared),
    ]);
    await scenario.approve(prdLane.id, input.ownerId);
    await scenario.approve(uiLane.id, input.ownerId);
    const development = await scenario.startDevelopment(prepared);
    const escapedName = `${basename(prepared.paths.root)}-escaped.txt`;
    const escapedPath = join(prepared.paths.root, "..", escapedName);
    await writeFile(join(prepared.paths.root, "package.json"), JSON.stringify({
      private: true,
      scripts: {
        test: `node -e "require('node:fs').writeFileSync('../${escapedName}', 'escaped')"`,
      },
    }));

    const result = await scenario.runTests(development);

    expect(result.passed).toBe(false);
    await expect(readFile(escapedPath, "utf8")).rejects.toThrow();
  });
});

test.skipIf(process.platform !== "darwin")("approved test processes cannot inherit host secrets or access external networks", async () => {
  const previousSecret = process.env.ANNA_T07_HOST_SECRET;
  process.env.ANNA_T07_HOST_SECRET = "must-not-cross-process-boundary";
  try {
    await withScenario(async (scenario) => {
      const prepared = await scenario.prepare();
      const [prdLane, uiLane] = await Promise.all([
        scenario.runPrdLane(prepared),
        scenario.runUiLane(prepared),
      ]);
      await scenario.approve(prdLane.id, input.ownerId);
      await scenario.approve(uiLane.id, input.ownerId);
      const development = await scenario.startDevelopment(prepared);
      await writeFile(join(prepared.paths.root, "package.json"), JSON.stringify({
        private: true,
        scripts: {
          test: [
            "node -e \"",
            "if(process.env.ANNA_T07_HOST_SECRET)process.exit(9);",
            "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1000)})",
            ".then(()=>process.exit(8),()=>process.exit(7))\"",
          ].join(""),
        },
      }));

      const result = await scenario.runTests(development);

      expect(result.evidence.exitCode).toBe(7);
      expect(result.evidence.stdout).not.toContain("must-not-cross-process-boundary");
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.ANNA_T07_HOST_SECRET;
    } else {
      process.env.ANNA_T07_HOST_SECRET = previousSecret;
    }
  }
});

test.skipIf(process.platform !== "darwin")("approved test processes cannot read files from host-home", async () => {
  const hostDirectory = await mkdtemp(join(homedir(), ".anna-t07-host-home-"));
  const hostSecret = join(hostDirectory, "secret.txt");
  await writeFile(hostSecret, "host-home-secret", "utf8");
  try {
    await withScenario(async (scenario) => {
      const prepared = await scenario.prepare();
      const [prdLane, uiLane] = await Promise.all([
        scenario.runPrdLane(prepared),
        scenario.runUiLane(prepared),
      ]);
      await scenario.approve(prdLane.id, input.ownerId);
      await scenario.approve(uiLane.id, input.ownerId);
      const development = await scenario.startDevelopment(prepared);
      await writeFile(join(prepared.paths.root, "package.json"), JSON.stringify({
        private: true,
        scripts: {
          test: `node -e "process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(hostSecret)}, 'utf8'))"`,
        },
      }));

      const result = await scenario.runTests(development);

      expect(result.passed).toBe(false);
      expect(result.evidence.stdout).not.toContain("host-home-secret");
    });
  } finally {
    await rm(hostDirectory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("contained UI proposals cannot follow a worktree symlink into host-home", async () => {
  const hostDirectory = await mkdtemp(join(homedir(), ".anna-t07-ui-host-home-"));
  const hostModule = join(hostDirectory, "host-secret.ts");
  await writeFile(hostModule, 'export const hostSecret = "worker-host-home-secret";\n', "utf8");
  try {
    await withScenario(async (scenario, _events, root) => {
      await symlink(hostModule, join(root, "src", "host-secret.ts"));
      await writeFile(join(root, input.uiPath), [
        'import { createRoot } from "react-dom/client";',
        'import { hostSecret } from "./host-secret";',
        'const panel = `before ${hostSecret}`;',
        'createRoot(document.getElementById("root")!).render(<main>{panel}</main>);',
        "",
      ].join("\n"));
      const prepared = await scenario.prepare();

      const rejection = await scenario.runUiLane(prepared).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect(String(rejection)).toContain("proposal build");
      expect(String(rejection)).not.toContain("worker-host-home-secret");
      await expect(readFile(hostModule, "utf8")).resolves.toContain("worker-host-home-secret");
    });
  } finally {
    await rm(hostDirectory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("approved test processes cannot access loopback services", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("unexpected");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  try {
    await withScenario(async (scenario) => {
      const prepared = await scenario.prepare();
      const [prdLane, uiLane] = await Promise.all([
        scenario.runPrdLane(prepared),
        scenario.runUiLane(prepared),
      ]);
      await scenario.approve(prdLane.id, input.ownerId);
      await scenario.approve(uiLane.id, input.ownerId);
      const development = await scenario.startDevelopment(prepared);
      await writeFile(join(prepared.paths.root, "package.json"), JSON.stringify({
        private: true,
        scripts: { test: `node -e "fetch('http://127.0.0.1:${port}').then(()=>process.exit(9),()=>process.exit(7))"` },
      }));

      const result = await scenario.runTests(development);

      expect(result.evidence.exitCode).toBe(7);
      expect(requests).toBe(0);
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    });
  }
});

test.skipIf(process.platform !== "darwin")("screenshot browser cannot access loopback services", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("unexpected");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  try {
    await withScenario(async (scenario, _events, root) => {
      await writeFile(join(root, input.uiPath), [
        'import { createRoot } from "react-dom/client";',
        `fetch("http://127.0.0.1:${port}").catch(() => undefined);`,
        'const panel = "before";',
        'createRoot(document.getElementById("root")!).render(<main>{panel}</main>);',
        "",
      ].join("\n"));

      const result = await scenario.run();

      expect(result.screenshot.visibleText).toBe("review-approved");
      expect(requests).toBe(0);
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    });
  }
});

test.skipIf(process.platform === "win32")("test evidence creation does not follow a symlink outside the worktree", async () => {
  const outside = await mkdtemp(join(tmpdir(), "anna-t07-artifact-outside-"));
  const outsideFile = join(outside, "evidence.json");
  await writeFile(outsideFile, "preserve-me", "utf8");
  try {
    await withScenario(async (scenario) => {
      const prepared = await scenario.prepare();
      const [prdLane, uiLane] = await Promise.all([
        scenario.runPrdLane(prepared),
        scenario.runUiLane(prepared),
      ]);
      await scenario.approve(prdLane.id, input.ownerId);
      await scenario.approve(uiLane.id, input.ownerId);
      const development = await scenario.startDevelopment(prepared);
      await symlink(outsideFile, join(prepared.paths.root, "test-results.json"));

      await expect(scenario.runTests(development)).rejects.toThrow("test evidence artifact write failed");
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("preserve-me");
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test.each([
  "dist",
  "dist/.t07-entry",
  "dist/t07-ui-build",
])("UI build refuses a %s symlink that escapes the worktree", async (relativePath) => {
  const outside = await mkdtemp(join(tmpdir(), "anna-t07-build-outside-"));
  const sentinel = join(outside, "preserve.txt");
  await writeFile(sentinel, "preserve-me", "utf8");
  try {
    await withScenario(async (scenario, _events, root) => {
      const target = join(root, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await symlink(outside, target);

      await expect(scenario.run()).rejects.toThrow(/build|symlink|worktree/i);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve-me");
      await expect(readdir(outside)).resolves.toEqual(["preserve.txt"]);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(process.platform === "win32")("screenshot creation does not follow a symlink outside the worktree", async () => {
  const outside = await mkdtemp(join(tmpdir(), "anna-t07-screenshot-outside-"));
  const outsideFile = join(outside, "review-screenshot.png");
  await writeFile(outsideFile, "preserve-me", "utf8");
  try {
    await withScenario(async (scenario, _events, root) => {
      await mkdir(join(root, "dist"), { recursive: true });
      await symlink(outsideFile, join(root, "dist", "review-screenshot.png"));

      await expect(scenario.run()).rejects.toThrow(/screenshot|symlink|worktree/i);
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("preserve-me");
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("failed tests block the merge-ready outcome", async () => {
  await withScenario(async (scenario) => {
    const prepared = await scenario.prepare();
    const [prdLane, uiLane] = await Promise.all([
      scenario.runPrdLane(prepared),
      scenario.runUiLane(prepared),
    ]);
    await scenario.approve(prdLane.id, input.ownerId);
    await scenario.approve(uiLane.id, input.ownerId);
    const development = await scenario.startDevelopment(prepared);
    await writeFile(join(prepared.paths.root, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"process.exit(7)\"" },
    }));

    const result = await scenario.runTests(development);

    expect(result.mergeReady).toBe(false);
    expect(result.blockedBy).toContain("tests");
    expect(result.evidence.exitCode).toBe(7);
    expect(result.evidence.command).toBe("npm test");
  });
});

test("a failed terminal restores its persisted blocked result without rerunning effects", async () => {
  await withScenario(async (scenario, events, root) => {
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"process.exit(7)\"" },
    }));
    const first = await scenario.run();
    expect(first).toMatchObject({
      mergeReady: false,
      blockedBy: expect.arrayContaining(["tests"]),
    });

    const configured = scenarioOptions(root, input, events as never);
    const restarted = createReviewToValidatedPatch(configured.options);
    await expect(restarted.run()).resolves.toMatchObject({
      mergeReady: false,
      blockedBy: expect.arrayContaining(["tests"]),
    });
    const recorded: CanonicalEvent[] = [];
    for await (const event of events.read(first.traceId as never)) recorded.push(event);
    expect(recorded.filter((event) => event.type === "run.failed")).toHaveLength(1);
  });
});

test("development changes an approved test source and executes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-t07-test-source-"));
  const sourceTestInput = {
    ...input,
    testPath: "test/review-visible.test.mjs",
  } as ReviewScenarioInput & { readonly testPath: string };
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(join(root, sourceTestInput.prdPath), "# Review PRD\n");
    await writeFile(join(root, sourceTestInput.uiPath), [
      'import { createRoot } from "react-dom/client";',
      'const panel = "before";',
      'createRoot(document.getElementById("root")!).render(<main>{panel}</main>);',
      '',
    ].join("\n"));
    await writeFile(join(root, sourceTestInput.testPath), [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("baseline", () => assert.equal(1, 1));',
      '',
    ].join("\n"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: `node --test ${sourceTestInput.testPath}` },
    }));
    await execFile("git", ["init", "--quiet", root]);
    await execFile("git", ["-C", root, "config", "user.email", "t07@example.invalid"]);
    await execFile("git", ["-C", root, "config", "user.name", "Anna T07 Test"]);
    await execFile("git", ["-C", root, "add", "."]);
    await execFile("git", ["-C", root, "commit", "--quiet", "-m", "test baseline"]);
    const configured = scenarioOptions(root, sourceTestInput);

    const result = await createReviewToValidatedPatch(configured.options).run();

    expect(result.git.diff).toContain(sourceTestInput.testPath);
    expect(result.testEvidence.stdout).toContain("tests 2");
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: sourceTestInput.testPath, validationStatus: "passed" }),
    ]));
    const canonicalEvents = [];
    for await (const event of configured.events.read(result.traceId as never)) {
      canonicalEvents.push(event);
    }
    const sourceArtifactEvents = canonicalEvents
      .filter((event) => event.type === "t07.artifact.recorded")
      .map((event) => (event.payload as { artifact?: { path?: string; validationStatus?: string } }).artifact)
      .filter((artifact) => artifact?.path === sourceTestInput.testPath);
    expect(sourceArtifactEvents.at(-1)?.validationStatus).toBe("passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run is blocked without explicit human approval and durable Scheduler seams", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-t07-human-gate-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, input.prdPath), "# Review PRD\n");
    await writeFile(join(root, input.uiPath), [
      'import { createRoot } from "react-dom/client";',
      'const panel = "before";',
      'createRoot(document.getElementById("root")!).render(<main data-review-panel="true">{panel}</main>);',
      "",
    ].join("\n"));
    const base = scenarioOptions(root).options;

    await expect(createReviewToValidatedPatch({
      ...base,
      approvalProvider: undefined,
    }).run()).rejects.toThrow("human approval");
    await expect(createReviewToValidatedPatch({
      ...base,
      scheduler: undefined,
    }).run()).rejects.toThrow("Scheduler");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("screenshot evidence is produced from the changed UI build", async () => {
  await withScenario(async (scenario) => {
    const result = await scenario.run();

    expect(result.screenshot.sourceBuildHash).toBe(result.uiBuild.hash);
    expect(result.screenshot.changedFiles).toContain(input.uiPath);
    expect(result.screenshot.path).toMatch(/screenshot\.(png|svg)$/);
    expect(result.testEvidence).toMatchObject({ command: "npm test", exitCode: 0 });
    expect(result.testEvidence.stdout).toContain("t07-test-ok");
    expect(result.eval.passed).toBe(true);
  });
});

test("the Owner receives a rendered UI proposal before approving its source change", async () => {
  await withScenario(async (_scenario, events, root) => {
    const originalUi = await readFile(join(root, input.uiPath), "utf8");
    let reviewedScreenshot = false;
    const configured = scenarioOptions(root, input, events as never);
    const scenario = createReviewToValidatedPatch({
      ...configured.options,
      approvalProvider: {
        ...ownerApproval,
        async approveLane(lane) {
          if (lane.lane === "ui") {
            const evidence = lane as typeof lane & {
              readonly uiBuild?: ReviewArtifact;
              readonly screenshot?: ReviewArtifact;
            };
            expect(evidence.uiBuild?.kind).toBe("ui-build");
            expect(evidence.screenshot).toMatchObject({
              kind: "screenshot",
              sourceBuildHash: evidence.uiBuild?.hash,
              visibleText: "review-approved",
            });
            expect((await readFile(join(root, evidence.screenshot!.path))).byteLength).toBeGreaterThan(100);
            await expect(readFile(join(root, input.uiPath), "utf8")).resolves.toBe(originalUi);
            reviewedScreenshot = true;
          }
          return { approved: true, actorId: input.ownerId };
        },
      },
    });

    await scenario.run();

    expect(reviewedScreenshot).toBe(true);
    void events;
  });
}, 20_000);

test("technical gates produce a merge-ready candidate while the human decision stays pending", async () => {
  await withScenario(async (scenario) => {
    const result = await scenario.run();

    expect(result.mergeReady).toBe(true);
    expect(result.blockedBy).toEqual([]);
    expect(result.humanMergeDecision).toBe("pending");
  });
});

test("changed UI build does not write the worktree root index.html", async () => {
  await withScenario(async (scenario) => {
    const prepared = await scenario.prepare();
    const indexPath = join(prepared.paths.root, "index.html");
    const originalIndex = "<!doctype html><title>existing root entry</title>\n";
    await writeFile(indexPath, originalIndex);
    await chmod(indexPath, 0o444);
    const [prdLane, uiLane] = await Promise.all([
      scenario.runPrdLane(prepared),
      scenario.runUiLane(prepared),
    ]);
    await scenario.approve(prdLane.id, input.ownerId);
    await scenario.approve(uiLane.id, input.ownerId);

    try {
      await expect(scenario.startDevelopment(prepared)).resolves.toBeDefined();
      await expect(readFile(indexPath, "utf8")).resolves.toBe(originalIndex);
    } finally {
      await chmod(indexPath, 0o644);
    }
  });
});

test("UI build Artifact hash changes when binary build output bytes change", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-t07-binary-hash-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, input.prdPath), "# Review PRD\n");
    await writeFile(join(root, input.uiPath), [
      'import { createRoot } from "react-dom/client";',
      'createRoot(document.getElementById("root")!).render(<main>Review approved</main>);',
      "",
    ].join("\n"));
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node -e \"process.exit(0)\"" } }));
    await initializeTestRepository(root, input);
    const configured = scenarioOptions(root);
    const result = await createReviewToValidatedPatch(configured.options).run();
    const buildFile = join(root, result.uiBuild.path, "assets", "index-Dibk9qNI.js");
    const files = await readdir(join(root, result.uiBuild.path, "assets"));
    const firstAsset = files.find((file) => file.endsWith(".js"));
    expect(firstAsset).toBeDefined();
    const assetPath = join(root, result.uiBuild.path, "assets", firstAsset!);
    const original = await readFile(assetPath);
    await writeFile(assetPath, Buffer.concat([original, Buffer.from([0xff])]));
    const changed = await readFile(assetPath);
    expect(hashBytesForTest(changed)).not.toBe(hashBytesForTest(original));
    await expect(createReviewToValidatedPatch(configured.options).restore()).rejects.toThrow(
      "UI build Artifact hash does not match its bytes",
    );
    expect(buildFile).toContain("assets");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build digests sort relative paths by raw UTF-8 bytes and hash file bytes unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-t07-digest-order-"));
  try {
    const upper = join(root, "Z.bin");
    const lower = join(root, "a.bin");
    const upperBytes = Buffer.from([0xff, 0x00, 0x41]);
    const lowerBytes = Buffer.from([0x80, 0x42]);
    await writeFile(upper, upperBytes);
    await writeFile(lower, lowerBytes);
    const expected = createHash("sha256")
      .update(Buffer.from("Z.bin"))
      .update(Buffer.from([0]))
      .update(upperBytes)
      .update(Buffer.from("a.bin"))
      .update(Buffer.from([0]))
      .update(lowerBytes)
      .digest("hex");

    await expect(digestFilesForTest(root, [lower, upper])).resolves.toBe(`sha256:${expected}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("main.tsx review patch is visible in the rendered screenshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-t07-visible-main-"));
  const visibleInput: ReviewScenarioInput = {
    ...input,
    uiPath: "src/main.tsx",
  };
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, visibleInput.prdPath), "# Review PRD\n");
    await writeFile(join(root, visibleInput.uiPath), [
      'import { StrictMode } from "react";',
      'import { createRoot } from "react-dom/client";',
      'const App = () => <main>Anna</main>;',
      'createRoot(document.getElementById("root")!).render(',
      '  <StrictMode>',
      '    <App />',
      '  </StrictMode>,',
      ');',
      '',
    ].join("\n"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"process.exit(0)\"" },
    }));
    await initializeTestRepository(root, visibleInput);
    const configured = scenarioOptions(root, visibleInput);

    const result = await createReviewToValidatedPatch(configured.options).run();

    await expect(readFile(join(root, visibleInput.uiPath), "utf8")).resolves.toContain(
      '<output data-t07-review="approved">Review approved</output>',
    );
    expect(result.screenshot).toMatchObject({ visibleText: "Review approved" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact producer, hash and version remain stable after a restart", async () => {
  const container = await mkdtemp(join(tmpdir(), "anna-t07-restart-"));
  const root = join(container, "worktree");
  const databasePath = join(container, "events.sqlite");
  let activeStore: SqliteEventStore | undefined;
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, input.prdPath), "# Review PRD\n");
    await writeFile(join(root, input.uiPath), [
      'import { createRoot } from "react-dom/client";',
      'const panel = "before";',
      'createRoot(document.getElementById("root")!).render(<main data-review-panel="true">{panel}</main>);',
      "",
    ].join("\n"));
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node -e \"process.exit(0)\"" } }));
    await initializeTestRepository(root, input);
    activeStore = new SqliteEventStore(databasePath);
    const configured = scenarioOptions(root, input, activeStore.scope({
      workspaceId: input.workspaceId as never,
      channelId: input.channelId as never,
    }));
    const first = createReviewToValidatedPatch(configured.options);
    const result = await first.run();

    activeStore.close();
    activeStore = undefined;
    activeStore = new SqliteEventStore(databasePath);
    const reopened = scenarioOptions(root, input, activeStore.scope({
      workspaceId: input.workspaceId as never,
      channelId: input.channelId as never,
    }));
    const restarted = createReviewToValidatedPatch(reopened.options);
    await expect(restarted.restore()).resolves.toMatchObject({
      artifacts: result.artifacts.map((artifact) => ({
        id: artifact.id,
        hash: artifact.hash,
        producerRunId: artifact.producerRunId,
        version: artifact.version,
      })),
      gates: result.gates,
      trace: result.trace,
    });
  } finally {
    activeStore?.close();
    await rm(container, { recursive: true, force: true });
  }
});

test("restore fails closed when a persisted PRD Artifact drifts", async () => {
  const container = await mkdtemp(join(tmpdir(), "anna-t07-prd-drift-"));
  const root = join(container, "worktree");
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, input.prdPath), "# Review PRD\n");
    await writeFile(join(root, input.uiPath), 'import { createRoot } from "react-dom/client"; const panel = "before"; createRoot(document.getElementById("root")!).render(<main>{panel}</main>);\n');
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node -e \"process.exit(0)\"" } }));
    await initializeTestRepository(root, input);
    const configured = scenarioOptions(root);
    const first = await createReviewToValidatedPatch(configured.options).run();
    await writeFile(join(root, input.prdPath), "# Drifted PRD\n");
    await expect(createReviewToValidatedPatch(configured.options).restore()).rejects.toThrow(/prd Artifact hash/i);
    expect(first.mergeReady).toBe(true);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("command surface does not expose push, merge or deploy", async () => {
  await withScenario(async (scenario) => {
    expect(scenario.availableCommands()).not.toEqual(
      expect.arrayContaining(["git push", "git merge", "deploy"]),
    );
    await expect(scenario.executeCommand("git push")).rejects.toThrow("unavailable");
    await expect(scenario.executeCommand("git merge main")).rejects.toThrow("unavailable");
    await expect(scenario.executeCommand("deploy")).rejects.toThrow("unavailable");
    const result = await scenario.run();
    expect(result.commands).not.toEqual(expect.arrayContaining(["git push", "git merge", "deploy"]));
  });
});

test("MemoryCandidate requires Channel Owner confirmation and keeps source provenance", async () => {
  await withScenario(async (scenario) => {
    const prepared = await scenario.prepare();
    const candidate = await scenario.proposeMemoryCandidate(prepared);

    expect(candidate.confirmed).toBe(false);
    expect(candidate.sourceRunId).toBe(input.sourceRunId);
    await expect(scenario.confirmMemoryCandidate(candidate.id, "actor-other")).rejects.toThrow("Owner");
    await expect(scenario.confirmMemoryCandidate(candidate.id, input.ownerId)).resolves.toMatchObject({
      id: candidate.id,
      confirmed: true,
    });
  });
});

test("explicit follow-up is registered through the injected Scheduler seam", async () => {
  const scheduled: ScheduleRecord[] = [];
  await withScenario(async (scenario) => {
    const followUp = await scenario.scheduleFollowUp({
      dueAt: "2026-08-21T09:00:00.000Z",
      label: "Re-check the validated patch",
      scheduler: { schedule: async (record: ScheduleRecord) => { scheduled.push(record); return record; } },
    });

    expect(followUp.trigger.kind).toBe("explicit");
    expect(scheduled).toHaveLength(1);
    expect(followUp.audience).toEqual([input.ownerId]);
    expect(followUp.schedule.run).toMatchObject({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      budget: expect.any(Object),
      permissionScope: expect.any(String),
      stopCondition: expect.any(String),
      notificationAudience: [input.ownerId],
    });
    expect(() => parseSchedule(followUp.schedule)).not.toThrow();
  });
});

test("failed run records a canonical terminal event", async () => {
  await withScenario(async (scenario, events) => {
    const prepared = await scenario.prepare();
    const [prdLane, uiLane] = await Promise.all([
      scenario.runPrdLane(prepared),
      scenario.runUiLane(prepared),
    ]);
    await scenario.approve(prdLane.id, input.ownerId);
    await scenario.approve(uiLane.id, input.ownerId);
    await writeFile(join(prepared.paths.root, input.uiPath), "not valid React\n");
    await expect(scenario.run()).rejects.toThrow();
    const recorded: CanonicalEvent[] = [];
    for await (const event of events.read(prepared.traceId as never)) {
      recorded.push(event);
    }
    expect(recorded.some((event) => event.type === "run.failed")).toBe(true);
    await expect(scenario.run()).rejects.toThrow("already has a terminal failure");
    const afterRerun: CanonicalEvent[] = [];
    for await (const event of events.read(prepared.traceId as never)) {
      afterRerun.push(event);
    }
    expect(afterRerun.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(afterRerun.filter((event) => ["run.completed", "run.failed"].includes(event.type))).toHaveLength(1);
  });
}, 20_000);

test("Eval precedes one terminal event and the returned Trace includes both", async () => {
  await withScenario(async (scenario, events) => {
    const result = await scenario.run();
    const recorded: CanonicalEvent[] = [];
    for await (const event of events.read(result.traceId as never)) {
      recorded.push(event);
    }
    const evalIndex = recorded.findIndex((event) => event.type === "t07.eval.completed");
    const contractEvent = recorded.find((event) => event.type === "t07.eval.contract");
    const terminalEvents = recorded.filter((event) => ["run.completed", "run.failed"].includes(event.type));

    expect(evalIndex).toBeGreaterThanOrEqual(0);
    expect(contractEvent?.payload).toMatchObject({
      plannedTerminal: "run.completed",
      result: { passed: true },
    });
    expect(terminalEvents).toHaveLength(1);
    expect(recorded.indexOf(terminalEvents[0]!)).toBeGreaterThan(evalIndex);
    expect(result.trace.eventIds).toEqual(expect.arrayContaining([
      recorded[evalIndex]!.id,
      terminalEvents[0]!.id,
    ]));
  });
});

test("rerunning a completed durable trace restores without duplicate start or terminal events", async () => {
  await withScenario(async (scenario, events) => {
    const first = await scenario.run();

    await expect(scenario.run()).resolves.toEqual(first);

    const recorded: CanonicalEvent[] = [];
    for await (const event of events.read(first.traceId as never)) {
      recorded.push(event);
    }
    expect(recorded.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(recorded.filter((event) => ["run.completed", "run.failed"].includes(event.type))).toHaveLength(1);
  });
});

test("a completed terminal restores from a prepared result after Trace projection crashes", async () => {
  await withScenario(async (_scenario, events, root) => {
    const configured = scenarioOptions(root, input, events as never);
    const crashing = createReviewToValidatedPatch({
      ...configured.options,
      services: {
        ...configured.options.services,
        traceProjector: {
          project() {
            throw new Error("injected Trace projector crash");
          },
        },
      },
    });

    const traceId = (await crashing.prepare()).traceId;
    await expect(crashing.run()).rejects.toThrow("injected Trace projector crash");
    const allStreams = new Set<StreamId>([
      traceId as StreamId,
      `t07-result:${traceId}` as StreamId,
      ...await events.listRunStreamIds(traceId as never),
    ]);
    const allEvents: CanonicalEvent[] = [];
    for (const streamId of allStreams) {
      for await (const event of events.read(streamId)) allEvents.push(event);
    }
    expect(allEvents.filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(allEvents.some((event) => event.type === "t07.result.prepared")).toBe(true);
    expect(allEvents.some((event) => event.type === "t07.result.recorded")).toBe(false);

    const recovered = createReviewToValidatedPatch(configured.options);
    await expect(recovered.run()).resolves.toMatchObject({
      mergeReady: true,
      blockedBy: [],
      humanMergeDecision: "pending",
    });
  });
}, 20_000);

test("two SQLite instances sharing a trace durably claim one execution and one terminal", async () => {
  const container = await mkdtemp(join(tmpdir(), "anna-t07-concurrent-"));
  const root = join(container, "worktree");
  const databasePath = join(container, "events.sqlite");
  let activeStore: SqliteEventStore | undefined;
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, input.prdPath), "# Review PRD\n");
    await writeFile(join(root, input.uiPath), [
      'import { createRoot } from "react-dom/client";',
      'const panel = "before";',
      'createRoot(document.getElementById("root")!).render(<main>{panel}</main>);',
      "",
    ].join("\n"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"process.exit(0)\"" },
    }));
    await initializeTestRepository(root, input);
    activeStore = new SqliteEventStore(databasePath);
    const events = activeStore.scope({
      workspaceId: input.workspaceId as never,
      channelId: input.channelId as never,
    });
    const first = createReviewToValidatedPatch(scenarioOptions(root, input, events).options);
    const second = createReviewToValidatedPatch(scenarioOptions(root, input, events).options);
    const traceId = (await first.prepare()).traceId;

    const outcomes = await Promise.allSettled([first.run(), second.run()]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringMatching(/already.*claimed|in progress/i) }),
    });
    const streamIds = await events.listRunStreamIds(traceId as never);
    const recorded: CanonicalEvent[] = [];
    for (const streamId of streamIds) {
      for await (const event of events.read(streamId)) recorded.push(event);
    }
    expect(recorded.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(recorded.filter((event) => ["run.completed", "run.failed"].includes(event.type))).toHaveLength(1);
  } finally {
    activeStore?.close();
    await rm(container, { recursive: true, force: true });
  }
}, 20_000);

test("fixture mode uses an actual disposable Git worktree and separates live evidence", async () => {
  const fixture = await createDeterministicReviewFixture({ mode: "fixture" });
  try {
    const configured = scenarioOptions(fixture.worktreeRoot, fixture.input);
    const scenario = createReviewToValidatedPatch({ ...configured.options, mode: "fixture" });
    const result = await scenario.run();

    expect(result.evidenceMode).toBe("fixture");
    expect(result.git.worktreeRoot).toBe(fixture.worktreeRoot);
    expect(result.git.diff).toContain(fixture.input.uiPath);
    expect(result.git.status).toContain(" M ");
    expect(result.git.commands).toEqual(expect.arrayContaining(["git diff", "git status --short"]));
    expect(result.git.commands).not.toEqual(expect.arrayContaining(["git push", "git merge", "deploy"]));
  } finally {
    await fixture.cleanup();
  }
});

test("fixture evidence links canonical Artifact/Gate events to one Trace", async () => {
  const fixture = await createDeterministicReviewFixture({ mode: "fixture" });
  try {
    const configured = scenarioOptions(fixture.worktreeRoot, fixture.input);
    const result = await createReviewToValidatedPatch({ ...configured.options, mode: "fixture" }).run();

    expect(result.evidenceMode).toBe("fixture");
    expect(result.trace.traceId).toBe(result.traceId);
    expect(result.trace.traceId).toMatch(/^run:t07:/);
    expect(result.trace.artifactIds).toEqual(expect.arrayContaining(result.artifacts.map((artifact) => artifact.id)));
    expect(result.trace.gateIds).toEqual(expect.arrayContaining(result.gates.map((gate) => gate.id)));
    expect(result.trace.eventIds.length).toBeGreaterThan(0);
    expect(new Set(result.artifacts.map((artifact) => artifact.producerRunId)).size).toBeGreaterThan(0);
    expect(result.uiBuild.path).toMatch(/dist\/t07-ui-build/);
    expect(result.uiBuild.buildCommand).toBe("vite.build()");
    expect(result.uiBuild.buildEvidence).toMatchObject({
      command: "vite.build()",
      exitCode: 0,
      stderr: "",
    });
    expect(result.uiBuild.buildEvidence?.stdout).toContain("index.html");
    expect(result.screenshot.path).toMatch(/\.png$/);
    expect(result.screenshot.sourceBuildHash).toBe(result.uiBuild.hash);
    result.artifacts.forEach((artifact) => {
      expect(() => parseArtifact(artifact)).not.toThrow();
    });
    expect(result.artifacts.every((artifact) => artifact.validationStatus === "passed")).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

test("every canonical Gate references Artifact IDs instead of Lane IDs", async () => {
  await withScenario(async (scenario, events) => {
    const result = await scenario.run();
    const recorded: CanonicalEvent[] = [];
    for await (const event of events.read(result.traceId as never)) {
      recorded.push(event);
    }
    const gateArtifactIds = recorded
      .filter((event) => event.type === "t07.gate.recorded")
      .flatMap((event) => {
        const payload = event.payload as { gate?: { artifactIds?: unknown } };
        return Array.isArray(payload.gate?.artifactIds) ? payload.gate.artifactIds : [];
      });

    expect(gateArtifactIds.length).toBeGreaterThan(0);
    expect(gateArtifactIds.every((id) => typeof id === "string" && id.startsWith("artifact:"))).toBe(true);
  });
});

test("live canary mode cannot be created from the deterministic fixture", async () => {
  await expect(createDeterministicReviewFixture({ mode: "live" })).rejects.toThrow("live Anna repository");
});

test("live evidence has an explicit macOS-only platform contract", () => {
  expect(() => assertT07LivePlatform("darwin")).not.toThrow();
  for (const platform of ["linux", "win32"] as const) {
    try {
      assertT07LivePlatform(platform);
      throw new Error("expected unsupported platform failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewUnsupportedPlatformError);
      expect(error).toMatchObject({ code: "T07_UNSUPPORTED_PLATFORM", platform });
    }
  }
});

test("live canary requires the caller to pin the clean source checkout HEAD", async () => {
  const container = await mkdtemp(join(tmpdir(), "anna-t07-live-identity-"));
  const repository = join(container, "repository");
  try {
    await mkdir(join(repository, "docs"), { recursive: true });
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, input.prdPath), "# Review\n");
    await writeFile(join(repository, input.uiPath), "export const view = 'before';\n");
    await writeFile(join(repository, "package.json"), JSON.stringify({ private: true }));
    await initializeTestRepository(repository, input);
    const configured = scenarioOptions(repository);

    await expect(createReviewToValidatedPatch({
      ...configured.options,
      mode: "live",
      liveWorktree: { expectedHead: "", backendOrigin: "http://127.0.0.1:61391" },
    }).prepare()).rejects.toThrow("expected disposable-worktree HEAD");
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin" || !process.env.ANNA_T07_LIVE_BACKEND_ORIGIN)("live run creates its development worktree only after review approval", async () => {
  const container = await mkdtemp(join(tmpdir(), "anna-t07-live-after-approval-"));
  const repository = join(container, "repository");
  const source = join(container, "source");
  const scope = {
    workspaceId: "workspace-t07-live-after-approval",
    channelId: "channel-t07-live-after-approval",
  };
  const liveInput: ReviewScenarioInput = {
    ...scope,
    reviewNotes: "Keep the approved decision visible.",
    prdPath: "docs/review.md",
    uiPath: "src/review-panel.tsx",
    testPath: "src/review-panel.test.ts",
    ownerId: "actor-t07-live-after-approval",
    sourceRunId: "run-t07-live-after-approval",
    sourceEventIds: ["event-t07-live-after-approval"],
  };
  const events = new InMemoryEventStore().scope(scope as never);
  const preApprovalEvents: CanonicalEvent[][] = [];
  const preApprovalWorktrees: string[][] = [];
  const preApprovalStatuses: string[] = [];

  try {
    await mkdir(join(repository, "docs"), { recursive: true });
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, liveInput.prdPath), "# Review\n");
    await writeFile(join(repository, liveInput.uiPath), [
      'import { createRoot } from "react-dom/client";',
      'void fetch("/api/session/current");',
      'const panel = "before";',
      'createRoot(document.getElementById("root")!).render(<main className="ir-shell">{panel}</main>);',
      "",
    ].join("\n"));
    await writeFile(join(repository, liveInput.testPath!), [
      'import { expect, it } from "vitest";',
      "",
      'it("keeps the baseline test executable", () => {',
      "  expect(true).toBe(true);",
      "});",
      "",
    ].join("\n"));
    await writeFile(join(repository, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"process.exit(0)\"" },
    }));
    await writeFile(join(repository, ".gitignore"), "node_modules\n");
    await initializeTestRepository(repository, liveInput);
    await execFile("git", ["-C", repository, "add", ".gitignore"]);
    await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "ignore local dependencies"]);
    const expectedHead = (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    await execFile("git", ["-C", repository, "worktree", "add", "--quiet", "--detach", source, expectedHead]);
    await symlink(realpathSync(join(process.cwd(), "../..", "node_modules")), join(source, "node_modules"), "dir");
    const backendOrigin = process.env.ANNA_T07_LIVE_BACKEND_ORIGIN!;

    const readRunEvents = async (): Promise<CanonicalEvent[]> => {
      const traceId = `run:t07:${createHash("sha256")
        .update(`live:${liveInput.workspaceId}:${liveInput.channelId}:${liveInput.sourceRunId}`)
        .digest("hex")
        .slice(0, 16)}` as StreamId;
      const streamIds = new Set<StreamId>([
        traceId,
        ...await events.listRunStreamIds(traceId as never),
      ]);
      const recorded: CanonicalEvent[] = [];
      for (const streamId of streamIds) {
        for await (const event of events.read(streamId)) recorded.push(event);
      }
      return recorded;
    };
    const approvalProvider: ReviewApprovalProvider = {
      confirmMemoryCandidate: async () => ({ approved: true, actorId: liveInput.ownerId }),
      approveLane: async () => {
        preApprovalEvents.push(await readRunEvents());
        preApprovalWorktrees.push((await execFile("git", ["-C", source, "worktree", "list", "--porcelain"]))
          .stdout.split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length)));
        preApprovalStatuses.push((await execFile("git", ["-C", source, "status", "--short"])).stdout);
        return { approved: true, actorId: liveInput.ownerId };
      },
      approveEffect: async () => ({ approved: true, actorId: liveInput.ownerId }),
    };
    const result = await createReviewToValidatedPatch({
      ...scenarioOptions(source, liveInput, events).options,
      mode: "live",
      liveWorktree: { expectedHead, backendOrigin },
      approvalProvider,
    }).run();
    const recorded = await readRunEvents();
    const worktreeCreated = recorded.find((event) => event.type === "t07.worktree.created");

    expect(preApprovalEvents).toHaveLength(2);
    expect(preApprovalStatuses).toEqual(["", ""]);
    expect(preApprovalEvents.flat().some((event) => (
      event.type === "tool.effect.started"
      && (event.payload as { tool?: unknown }).tool === "create_isolated_worktree"
    ))).toBe(false);
    expect(preApprovalWorktrees.flat()).not.toContain(result.paths.root);
    expect(worktreeCreated).toMatchObject({
      payload: expect.objectContaining({ worktreeRoot: result.paths.root, expectedHead }),
    });
    expect(result.testEvidence).toMatchObject({
      command: `npm exec --no -- vitest run --configLoader runner ${liveInput.testPath}`,
      exitCode: 0,
    });
    expect(stripAnsiFromVitestEvidence(result.testEvidence.stdout)).toMatch(/Tests\s+2 passed/);
    expect(await realpath(join(result.paths.root, "node_modules"))).toBe(
      await realpath(join(source, "node_modules")),
    );
    expect(recorded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.approval.requested",
        payload: expect.objectContaining({ tool: "create_isolated_worktree" }),
      }),
      expect.objectContaining({
        type: "tool.approval.answered",
        payload: expect.objectContaining({ decision: "approved" }),
      }),
      expect.objectContaining({
        type: "tool.effect.started",
        payload: expect.objectContaining({ tool: "create_isolated_worktree" }),
      }),
      expect.objectContaining({
        type: "tool.effect.succeeded",
        payload: expect.objectContaining({ tool: "create_isolated_worktree" }),
      }),
    ]));
    const worktreeEffect = recorded.find((event) =>
      event.type === "tool.effect.succeeded"
      && (event.payload as { tool?: unknown }).tool === "create_isolated_worktree",
    );
    expect(worktreeEffect).toMatchObject({
      payload: expect.objectContaining({
        result: expect.objectContaining({
          output: expect.objectContaining({
            dependencyBridge: {
              sourceRoot: await realpath(source),
              dependencyRoot: await realpath(join(source, "node_modules")),
              readOnly: true,
            },
          }),
        }),
      }),
    });
    expect(result.paths.root).not.toBe(source);
    expect(result.git.worktreeRoot).toBe(result.paths.root);
    expect(result.screenshot.path).toBe("dist/review-screenshot.png");
    expect((await readFile(join(result.paths.root, result.screenshot.path))).byteLength).toBeGreaterThan(0);
    await expect(execFile("git", ["-C", source, "status", "--short"])).resolves.toMatchObject({ stdout: "" });
  } finally {
    await execFile("git", ["-C", repository, "worktree", "remove", "--force", source]).catch(() => undefined);
    await rm(container, { recursive: true, force: true });
  }
}, 120_000);

test("live canary refuses to start without an explicit local Anna backend", async () => {
  await withScenario(async (_scenario, _events, root) => {
    const configured = scenarioOptions(root);

    expect(() => createReviewToValidatedPatch({
      ...configured.options,
      mode: "live",
      liveWorktree: { expectedHead: "expected-live-head" },
    })).toThrow("explicit local Anna backend");
  });
});

test.skipIf(
  !process.env.ANNA_T07_LIVE_SOURCE
  || !process.env.ANNA_T07_LIVE_HEAD
  || !process.env.ANNA_T07_LIVE_BACKEND_ORIGIN,
)(
  "live Anna repository canary produces actual diff, screenshot, tests and canonical evidence",
  async () => {
    const root = process.env.ANNA_T07_LIVE_SOURCE!;
    const liveInput: ReviewScenarioInput = {
      workspaceId: "workspace-t07-live",
      channelId: "channel-t07-live",
      reviewNotes: "Record the T07 live canary review decision without changing Crew or desktop switching.",
      prdPath: "docs/product/anna-harness-v2-spec-2026-08-17.md",
      uiPath: "apps/desktop/src/main.tsx",
      testPath: "apps/desktop/src/lib/theme.test.ts",
      ownerId: "actor-t07-live-owner",
      sourceRunId: "run-t07-live-canary",
      sourceEventIds: ["event-t07-live-source"],
    };
    const configured = scenarioOptions(root, liveInput);
    const result = await createReviewToValidatedPatch({
      ...configured.options,
      mode: "live",
      approvalProvider: {
        confirmMemoryCandidate: async () => ({ approved: true, actorId: liveInput.ownerId }),
        approveLane: async () => ({ approved: true, actorId: liveInput.ownerId }),
        approveEffect: async () => ({ approved: true, actorId: liveInput.ownerId }),
      },
      liveWorktree: {
        expectedHead: process.env.ANNA_T07_LIVE_HEAD!,
        backendOrigin: process.env.ANNA_T07_LIVE_BACKEND_ORIGIN!,
      },
    }).run();

    expect(result.evidenceMode).toBe("live");
    expect(result.git.valid).toBe(true);
    expect(result.git.diff).toContain(liveInput.prdPath);
    expect(result.git.diff).toContain(liveInput.uiPath);
    expect(result.git.diff).toContain(liveInput.testPath);
    expect(result.git.status).not.toContain("index.html");
    expect(result.testEvidence).toMatchObject({
      command: `npm exec --no -- vitest run --configLoader runner ${liveInput.testPath}`,
      exitCode: 0,
    });
    expect(stripAnsiFromVitestEvidence(result.testEvidence.stdout)).toMatch(/Tests\s+6 passed/);
    expect(result.eval.passed).toBe(true);
    expect(result.screenshot.path).toMatch(/\.png$/);
    expect(result.screenshot.visibleText).toBe("Review approved");
    expect(result.trace.eventIds.length).toBeGreaterThan(0);
    const recorded: CanonicalEvent[] = [];
    for await (const event of configured.events.read(result.traceId as never)) recorded.push(event);
    expect(recorded).toContainEqual(expect.objectContaining({
      type: "t07.live.ui.api_confirmed",
      payload: expect.objectContaining({
        backendOrigin: process.env.ANNA_T07_LIVE_BACKEND_ORIGIN!,
        sessionStatus: 200,
        normalShell: true,
      }),
    }));
  },
  120_000,
);
