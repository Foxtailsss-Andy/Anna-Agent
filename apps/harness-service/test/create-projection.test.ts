import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import type { CanonicalEvent, ChannelScope, EventStore } from "@anna/harness-v2";
import { InMemoryEventStore } from "@anna/event-store";
import { parseStartRun } from "@anna/harness-v2";
import { startHarnessService } from "../src/index";
import { createSkillArtifact } from "../src/create-artifact";
import { projectCreateRun } from "../src/create-projection";
import { startReviewApprovalService } from "../src/review-approval";
import { resolvedRunProfileFixture } from "../../../packages/harness-v2/test/run-profile-fixture";

const scope: ChannelScope = {
  workspaceId: "workspace-create" as ChannelScope["workspaceId"],
  channelId: "channel-create" as ChannelScope["channelId"],
};

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
): CanonicalEvent {
  return {
    ...scope,
    id: `event-${seq}` as CanonicalEvent["id"],
    streamId: "run-create" as CanonicalEvent["streamId"],
    seq,
    type,
    timestamp: `2026-08-23T00:00:0${seq}.000Z`,
    schemaVersion: 1,
    payload,
  } as CanonicalEvent;
}

async function append(store: EventStore, value: CanonicalEvent): Promise<void> {
  await store.scope(scope).append(value);
}

const artifact = {
  kind: "skill",
  skill_id: "csv_to_markdown",
  path: "create-runs/run-create/skill/csv_to_markdown/SKILL.md",
  preview: "---\nname: CSV to Markdown\nversion: 1.0.0\n---\n",
  hash: "sha256:artifact-hash",
};

describe("Create v2 projection", () => {
  test("lists scoped Create projections from durable command metadata", async () => {
    const store = new InMemoryEventStore();
    const scoped = store.scope(scope);
    const first = parseStartRun({
      commandId: "command-create-1",
      runId: "run:create:command-create-1",
      goal: "Create the first skill.",
      surfaceId: "create",
      ...scope,
      source: { eventId: "source-create-1" },
      runProfile: { id: "profile-1", version: "1" },
      runProfileSnapshot: resolvedRunProfileFixture(),
      budget: { turns: 1 },
      permissionScope: "permission-1",
      stopCondition: "artifact_or_terminal",
    });
    const second = parseStartRun({
      ...first,
      commandId: "command-create-2",
      runId: "run:create:command-create-2",
      goal: "Create the second skill.",
      source: { eventId: "source-create-2" },
    });
    await scoped.claimStart(first);
    await scoped.claimStart(second);
    await scoped.append({ ...event(0, "run.started"), streamId: first.runId as never });
    await scoped.append({ ...event(1, "create.artifact.created", { artifact }), streamId: first.runId as never });
    await scoped.append({
      ...event(2, "create.artifact.validated", {
        validation: { valid: true, loaded_skill_id: "csv_to_markdown", errors: [] },
      }),
      streamId: first.runId as never,
    });
    await scoped.append({ ...event(3, "run.completed", { outcome: "completed" }), streamId: first.runId as never });
    const service = await startHarnessService({ eventStore: store });

    try {
      const response = await fetch(
        `${service.url}/v2/create/runs?workspace_id=workspace-create&channel_id=channel-create`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        runs: [
          expect.objectContaining({
            runId: first.runId,
            prompt: "Create the first skill.",
            status: "ready_for_review",
          }),
          expect.objectContaining({
            runId: second.runId,
            prompt: "Create the second skill.",
            status: "generating",
          }),
        ],
      });
    } finally {
      await service.close();
    }
  });

  test("projects a validated artifact to review, without implying activation", () => {
    const result = projectCreateRun("run-create", [
      event(0, "run.queued"),
      event(1, "run.started"),
      event(2, "create.artifact.created", { artifact }),
      event(3, "create.artifact.validated", {
        validation: { valid: true, loaded_skill_id: "csv_to_markdown", errors: [] },
      }),
      event(4, "run.eval.contract", { passed: true }),
      event(5, "run.completed", { outcome: "completed" }),
    ]);

    expect(result).toEqual({
      runId: "run-create",
      status: "ready_for_review",
      artifact,
      validation: { valid: true, loaded_skill_id: "csv_to_markdown", errors: [] },
      activation: { status: "blocked", reason: "create_activation_not_implemented" },
      error: undefined,
    });
  });

  test("fails closed when a completed Run has no Create artifact", () => {
    const result = projectCreateRun("run-create", [
      event(0, "run.started"),
      event(1, "run.completed", { outcome: "completed" }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "create_artifact_missing",
      message: "Create Run completed without an artifact.",
    });
  });

  test("keeps invalid validation out of review", () => {
    const result = projectCreateRun("run-create", [
      event(0, "run.started"),
      event(1, "create.artifact.created", { artifact }),
      event(2, "create.artifact.validated", {
        validation: { valid: false, errors: ["missing version"] },
      }),
      event(3, "run.completed", { outcome: "completed" }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.activation).toEqual({
      status: "blocked",
      reason: "create_validation_failed",
    });
  });

  test("requires validation before a completed Run can enter any product state", () => {
    const result = projectCreateRun("run-create", [
      event(0, "run.started"),
      event(1, "create.artifact.created", { artifact }),
      event(2, "run.completed", { outcome: "completed" }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "create_validation_missing",
      message: "Create artifact completed without validation.",
    });
  });

  test("does not trust an activation event without valid artifact evidence", () => {
    const result = projectCreateRun("run-create", [
      event(0, "run.started"),
      event(1, "create.artifact.activated", { artifact }),
      event(2, "run.completed", { outcome: "completed" }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.activation).toEqual({
      status: "blocked",
      reason: "create_artifact_missing",
    });
  });

  test("only an explicit activation event produces saved", () => {
    const result = projectCreateRun("run-create", [
      event(0, "run.started"),
      event(1, "create.artifact.created", { artifact }),
      event(2, "create.artifact.validated", {
        validation: { valid: true, errors: [] },
      }),
      event(3, "create.artifact.activated", { artifact }),
      event(4, "run.completed", { outcome: "completed" }),
    ]);

    expect(result.status).toBe("saved");
    expect(result.activation).toEqual({ status: "activated" });
  });

  test("serves the projection from the scoped Event Store", async () => {
    const store = new InMemoryEventStore();
    await append(store, event(0, "run.started"));
    await append(store, event(1, "create.artifact.created", { artifact }));
    await append(store, event(2, "create.artifact.validated", {
      validation: { valid: true, errors: [] },
    }));
    await append(store, event(3, "run.completed", { outcome: "completed" }));
    const service = await startHarnessService({ eventStore: store });

    try {
      const response = await fetch(
        `${service.url}/v2/runs/run-create/create?workspace_id=workspace-create&channel_id=channel-create`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        runId: "run-create",
        status: "ready_for_review",
        activation: { status: "blocked", reason: "create_activation_not_implemented" },
      });

      const crossScope = await fetch(
        `${service.url}/v2/runs/run-create/create?workspace_id=other&channel_id=channel-create`,
      );
      expect(crossScope.status).toBe(404);
    } finally {
      await service.close();
    }
  });

  test("returns an explicit unsupported response for activation", async () => {
    const store = new InMemoryEventStore();
    await append(store, event(0, "run.started"));
    const service = await startHarnessService({ eventStore: store });

    try {
      const response = await fetch(
        `${service.url}/v2/runs/run-create/create/activate?workspace_id=workspace-create&channel_id=channel-create`,
        { method: "POST" },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "create_activation_not_implemented",
        status: "unsupported",
      });
    } finally {
      await service.close();
    }
  });

  test("activates a validated artifact only after an explicit Owner decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-create-activation-"));
    const ownerId = "owner-create";
    const eventStore = new InMemoryEventStore();
    const preview = "---\nname: CSV Converter\nversion: 1.0.0\nallowed_tools:\nforbidden_tools:\n---\n\nConvert CSV.\n";
    let approvalService: Awaited<ReturnType<typeof startReviewApprovalService>> | undefined;
    let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;
    try {
      const created = await createSkillArtifact({
        workspaceRoot: directory,
        runId: "run-create",
        input: { kind: "skill", skill_id: "csv_to_markdown", preview },
      });
      if (created.status !== "succeeded" || typeof created.output !== "object" || created.output === null) {
        throw new Error("expected a Create artifact for activation");
      }
      const createdArtifact = created.output.artifact as Record<string, unknown>;
      const store = eventStore.scope(scope);
      await append(eventStore, event(0, "run.started"));
      await append(eventStore, event(1, "create.artifact.created", { artifact: createdArtifact }));
      await append(eventStore, event(2, "create.artifact.validated", {
        validation: { valid: true, loaded_skill_id: "csv_to_markdown", errors: [] },
      }));
      await append(eventStore, event(3, "run.completed", { outcome: "completed" }));
      approvalService = await startReviewApprovalService({
        ownerId,
        storePath: join(directory, "review-approval.jsonl"),
      });
      service = await startHarnessService({
        eventStore,
        createActivation: {
          workspaceRoot: directory,
          approvalOrigin: approvalService.url,
          ownerId,
        },
      });

      const activationPromise = fetch(
        `${service.url}/v2/runs/run-create/create/activate?workspace_id=workspace-create&channel_id=channel-create`,
        { method: "POST", headers: { "x-anna-owner-id": ownerId } },
      );
      const pending = await waitForCreateApproval(approvalService.url, ownerId);
      expect(pending.subject).toEqual({
        effectKey: `create.activate:run-create:${createdArtifact.hash}`,
      });
      const decision = await fetch(`${approvalService.url}/requests/${encodeURIComponent(pending.requestId)}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-anna-owner-id": ownerId,
        },
        body: JSON.stringify({ ownerId, approved: true }),
      });
      expect(decision.status).toBe(200);

      const response = await activationPromise;
      const responseBody = await response.json();
      expect(response.status, JSON.stringify(responseBody)).toBe(200);
      expect(responseBody).toMatchObject({
        status: "saved",
        activation: { status: "activated" },
      });
      await expect(readFile(join(directory, "skills/csv_to_markdown/SKILL.md"), "utf8"))
        .resolves.toBe(preview);
      const activatedEvents: CanonicalEvent[] = [];
      for await (const storedEvent of store.read("run-create" as never)) activatedEvents.push(storedEvent);
      for await (const storedEvent of store.read("create-activation:run-create" as never)) activatedEvents.push(storedEvent);
      expect(activatedEvents.at(-1)?.type).toBe("create.artifact.activated");
    } finally {
      await service?.close();
      await approvalService?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitForCreateApproval(
  origin: string,
  ownerId: string,
): Promise<{ requestId: string; subject: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${origin}/requests`, {
      headers: { "x-anna-owner-id": ownerId },
    });
    const body = await response.json() as { requests?: Array<Record<string, unknown>> };
    const pending = body.requests?.[0];
    if (typeof pending?.request_id === "string"
      && typeof pending.subject === "object"
      && pending.subject !== null
      && !Array.isArray(pending.subject)) {
      return {
        requestId: pending.request_id,
        subject: pending.subject as Record<string, unknown>,
      };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Create activation approval was not persisted in time");
}
