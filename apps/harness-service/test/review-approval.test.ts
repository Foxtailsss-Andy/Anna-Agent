import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { createHttpReviewApprovalProvider } from "@anna/harness-v2";
import { startReviewApprovalService } from "../src/review-approval";

test("Owner approval bridge waits for an explicit decision and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-review-approval-"));
  const storePath = join(directory, "decisions.jsonl");
  const ownerId = "owner-local";
  let service = await startReviewApprovalService({ ownerId, storePath, decisionTimeoutMs: 5_000 });

  try {
    const statusResponse = await fetch(`${service.url}/status`);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      status: "ready",
      owner_id: ownerId,
      decision_endpoint: "ready",
      durability: "durable",
      pending_requests: 0,
    });

    const provider = createHttpReviewApprovalProvider({ origin: service.url, ownerId });
    const pendingDecision = provider.approveEffect("effect:local-1");
    const pending = await waitForPending(service.url, ownerId);
    expect(pending.action).toBe("approve_effect");
    expect(pending.subject).toEqual({ effectKey: "effect:local-1" });

    const operatorResponse = await fetch(`${service.url}/requests/${encodeURIComponent(pending.request_id)}/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anna-owner-id": ownerId,
      },
      body: JSON.stringify({ ownerId, approved: true }),
    });
    expect(operatorResponse.status).toBe(200);
    await expect(operatorResponse.json()).resolves.toMatchObject({
      approved: true,
      actorId: ownerId,
    });
    await expect(pendingDecision).resolves.toEqual({ approved: true, actorId: ownerId });

    await service.close();
    service = await startReviewApprovalService({ ownerId, storePath, decisionTimeoutMs: 5_000 });
    const restoredProvider = createHttpReviewApprovalProvider({ origin: service.url, ownerId });
    await expect(restoredProvider.approveEffect("effect:local-1")).resolves.toEqual({
      approved: true,
      actorId: ownerId,
    });

    const records = (await readFile(storePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.recordType)).toEqual(["request", "decision"]);
    expect(records[1]).toMatchObject({ approved: true, actorId: ownerId });
  } finally {
    await service.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Owner approval bridge rejects owner drift before creating a durable request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-review-approval-"));
  const service = await startReviewApprovalService({
    ownerId: "owner-local",
    storePath: join(directory, "decisions.jsonl"),
    decisionTimeoutMs: 1_000,
  });

  try {
    const response = await fetch(`${service.url}/decisions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anna-owner-id": "attacker",
      },
      body: JSON.stringify({
        ownerId: "attacker",
        action: "approve_effect",
        effectKey: "effect:should-not-enter-store",
      }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "owner_identity_mismatch" });

    const pending = await fetch(`${service.url}/requests`, {
      headers: { "x-anna-owner-id": "owner-local" },
    });
    await expect(pending.json()).resolves.toEqual({ requests: [] });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForPending(
  origin: string,
  ownerId: string,
): Promise<{
  readonly request_id: string;
  readonly action: string;
  readonly subject: Record<string, unknown>;
}> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${origin}/requests`, {
      headers: { "x-anna-owner-id": ownerId },
    });
    const body = await response.json() as { requests?: Array<Record<string, unknown>> };
    const request = body.requests?.[0];
    if (request !== undefined
      && typeof request.request_id === "string"
      && typeof request.action === "string"
      && typeof request.subject === "object"
      && request.subject !== null
      && !Array.isArray(request.subject)) {
      return {
        request_id: request.request_id,
        action: request.action,
        subject: request.subject as Record<string, unknown>,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Owner approval request was not persisted in time");
}
