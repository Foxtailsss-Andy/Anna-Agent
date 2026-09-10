import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

type ReviewHarness = {
  readonly directory: string;
  readonly sourcePath: string;
  readonly workbenchPath: string;
  readonly stateDbPath: string;
  readonly business: Awaited<ReturnType<typeof startBusinessFixture>>;
  readonly host: Awaited<ReturnType<typeof startProductHost>>;
  readonly close: () => Promise<void>;
};

test("cross-workspace Project Session access matches a missing Session for GET and POST", async () => {
  const harness = await startReviewHarness();
  try {
    const projectResponse = await fetch(`${harness.business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: harness.business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ goal_text: "WB01 authorization review project", sop_template_id: "feature_iteration" }),
    });
    expect(projectResponse.status).toBe(200);
    const project = await projectResponse.json() as { id: string };

    const created = await jsonRequest(harness.host.url, "/api/workbench/sessions", harness.business.authorization, {
      method: "POST",
      body: { surface: "chat", project_id: project.id },
    });
    expect(created.status).toBe(201);
    const sessionId = (created.body as { session_id: string }).session_id;

    const otherLogin = await fetch(`${harness.business.origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@anna.demo", password: "other-demo" }),
    });
    expect(otherLogin.status).toBe(200);
    const otherToken = (await otherLogin.json() as { token: string }).token;
    const otherAuthorization = `Bearer ${otherToken}`;

    const existing = await jsonRequest(harness.host.url, `/api/workbench/sessions/${sessionId}`, otherAuthorization);
    const missing = await jsonRequest(harness.host.url, "/api/workbench/sessions/missing-review-session", otherAuthorization);
    expect(existing.status).toBe(404);
    expect(existing.body).toEqual({ code: "session_not_found" });
    expect(existing.body).toEqual(missing.body);

    const postExisting = await jsonRequest(
      harness.host.url,
      `/api/workbench/sessions/${sessionId}/runs`,
      otherAuthorization,
      { method: "POST", body: { prompt: "probe", source_event_id: "cross-workspace-probe" } },
    );
    const postMissing = await jsonRequest(
      harness.host.url,
      "/api/workbench/sessions/missing-review-session/runs",
      otherAuthorization,
      { method: "POST", body: { prompt: "probe", source_event_id: "missing-session-probe" } },
    );
    expect(postExisting.status).toBe(404);
    expect(postExisting.body).toEqual({ code: "session_not_found" });
    expect(postExisting.body).toEqual(postMissing.body);

    const beforeRevocation = await jsonRequest(
      harness.host.url,
      `/api/workbench/sessions/${sessionId}`,
      harness.business.authorization,
    );
    expect(beforeRevocation.status).toBe(200);
    execFileSync(resolve(repositoryRoot, ".venv/bin/python"), ["-c", `import sys
from services.crew.app.store import SQLiteCrewStore
store=SQLiteCrewStore(sys.argv[1])
project=store.get_project(sys.argv[2])
assert project is not None
project.workspace_id='ws_other'
store.save_project(project)
`, harness.stateDbPath, project.id], { cwd: repositoryRoot });
    const revokedExisting = await jsonRequest(
      harness.host.url,
      `/api/workbench/sessions/${sessionId}`,
      harness.business.authorization,
    );
    const revokedMissing = await jsonRequest(
      harness.host.url,
      "/api/workbench/sessions/missing-review-session",
      harness.business.authorization,
    );
    const revokedPost = await jsonRequest(
      harness.host.url,
      `/api/workbench/sessions/${sessionId}/runs`,
      harness.business.authorization,
      { method: "POST", body: { prompt: "revoked", source_event_id: "revoked" } },
    );
    expect(revokedExisting.status).toBe(404);
    expect(revokedExisting.body).toEqual({ code: "session_not_found" });
    expect(revokedExisting.body).toEqual(revokedMissing.body);
    expect(revokedPost.status).toBe(404);
    expect(revokedPost.body).toEqual({ code: "session_not_found" });
    expect(revokedPost.body).toEqual(revokedMissing.body);

    const invalidToken = await jsonRequest(
      harness.host.url,
      `/api/workbench/sessions/${sessionId}`,
      "Bearer invalid-review-token",
    );
    expect(invalidToken.status).toBe(401);
    expect(invalidToken.body).toEqual({ code: "authentication_required" });
  } finally {
    await harness.close();
  }
}, 120_000);

test("migration scope summary hides rejected Project records", async () => {
  const harness = await startReviewHarness();
  try {
    const before = await jsonRequest(
      harness.host.url,
      "/api/workbench/migrations/product-v1",
      harness.business.authorization,
      { method: "POST", body: { dry_run: true } },
    );
    expect(before.status).toBe(200);

    await writeFile(harness.sourcePath, `${JSON.stringify([{
      task: {
        run_id: "inaccessible-project-history",
        workspace_id: harness.business.workspaceId,
        actor_user_id: harness.business.actorUserId,
        surface: "crew",
        prompt: "hidden original",
        channel_id: "crew_channel:foreign-or-revoked-project",
        conversation_id: "hidden-conversation",
        context: { project_id: "foreign-or-revoked-project" },
        resource_refs: [],
      },
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    }])}\n`, "utf8");

    const after = await jsonRequest(
      harness.host.url,
      "/api/workbench/migrations/product-v1",
      harness.business.authorization,
      { method: "POST", body: { dry_run: true } },
    );
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      matched_records: 0,
      sessions_added: 0,
      runs_added: 0,
      sessions: [],
      runs: [],
    });
    expect(after.body).not.toHaveProperty("skipped_project_records");
    expect(after.body).toEqual(before.body);
  } finally {
    await harness.close();
  }
}, 120_000);

test("a repaired Workbench sidecar can be retried by migration, GET, and POST on the same Host", async () => {
  const harness = await startReviewHarness();
  try {
    await writeFile(harness.workbenchPath, "broken json\n", "utf8");

    const failedMigration = await jsonRequest(
      harness.host.url,
      "/api/workbench/migrations/product-v1",
      harness.business.authorization,
      { method: "POST", body: { dry_run: true } },
    );
    const failedGet = await jsonRequest(harness.host.url, "/api/workbench/sessions", harness.business.authorization);
    const failedPost = await jsonRequest(
      harness.host.url,
      "/api/workbench/sessions",
      harness.business.authorization,
      { method: "POST", body: { surface: "chat" } },
    );
    expect(failedMigration.status).toBe(500);
    expect(failedGet.status).toBe(500);
    expect(failedPost.status).toBe(500);

    await writeFile(harness.workbenchPath, `${JSON.stringify({ schema_version: 2, sessions: [], runs: [] })}\n`, "utf8");

    const repairedMigration = await jsonRequest(
      harness.host.url,
      "/api/workbench/migrations/product-v1",
      harness.business.authorization,
      { method: "POST", body: { dry_run: true } },
    );
    expect(repairedMigration.status).toBe(200);
    expect(repairedMigration.body).toMatchObject({ sessions_added: 0, runs_added: 0 });

    const repairedGet = await jsonRequest(harness.host.url, "/api/workbench/sessions", harness.business.authorization);
    expect(repairedGet.status).toBe(200);
    expect(repairedGet.body).toEqual({ sessions: [] });
    const repairedPost = await jsonRequest(
      harness.host.url,
      "/api/workbench/sessions",
      harness.business.authorization,
      { method: "POST", body: { surface: "chat" } },
    );
    expect(repairedPost.status).toBe(201);
  } finally {
    await harness.close();
  }
}, 120_000);

async function startReviewHarness(): Promise<ReviewHarness> {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb01-review-regressions-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sourcePath = join(directory, "sessions.json");
  const workbenchPath = join(directory, "workbench.json");
  const stateDbPath = join(directory, "business.sqlite3");
  const workspaceRoot = join(directory, "workspace");
  const productPort = await findFreePort();
  const descriptor = await createOmpKernelDescriptor(materializedRoot);
  await writeFile(configPath, JSON.stringify({
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: materializedRoot,
    harness_v2_omp_descriptor: descriptor,
  }), "utf8");
  await writeFile(sourcePath, "[]\n", "utf8");

  const business = await startBusinessFixture(
    stateDbPath,
    `http://127.0.0.1:${productPort}`,
  );
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  try {
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat", "crew"],
      requireOmp: true,
      allowUnconfigured: true,
      ompRuntimeRoot: materializedRoot,
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: productPort,
      serviceToken: "wb01-review-host-token",
      sessionStorePath: sourcePath,
      workbenchSessionStorePath: workbenchPath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const runningHost = host;
    const runningLive = live;
    return {
      directory,
      sourcePath,
      workbenchPath,
      stateDbPath,
      business,
      host: runningHost,
      close: async () => {
        await runningHost.close();
        await runningLive.close();
        await business.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function jsonRequest(
  origin: string,
  path: string,
  authorization: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
