import { createServer } from "node:http";

import { expect, test } from "vitest";

import {
  createHttpReviewApprovalProvider,
  type ReviewLaneOutput,
  type ReviewMemoryCandidate,
} from "../src/index";

test("HTTP Review Approval Provider sends owner-scoped decisions and preserves actor identity", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ approved: true, actorId: "owner-1" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("approval test server did not bind");

  try {
    const provider = createHttpReviewApprovalProvider({
      origin: `http://127.0.0.1:${address.port}`,
      ownerId: "owner-1",
    });
    const candidate = {
      id: "candidate-1",
      content: "Keep the owner decision visible.",
      sourceRunId: "source-run-1",
      sourceEventIds: ["source-event-1"],
      traceId: "trace-1",
      confirmed: false,
    } satisfies ReviewMemoryCandidate;
    const lane = {
      id: "lane-1",
      lane: "prd",
      kind: "proposal",
      traceId: "trace-1",
      targetPath: "docs/review.md",
      candidate: "# Review",
      approved: false,
    } satisfies ReviewLaneOutput;

    await expect(provider.confirmMemoryCandidate(candidate)).resolves.toEqual({
      approved: true,
      actorId: "owner-1",
    });
    await expect(provider.approveLane(lane)).resolves.toEqual({
      approved: true,
      actorId: "owner-1",
    });
    await expect(provider.approveEffect("effect-1")).resolves.toEqual({
      approved: true,
      actorId: "owner-1",
    });
    expect(requests.map((request) => request.action)).toEqual([
      "confirm_memory_candidate",
      "approve_lane",
      "approve_effect",
    ]);
    expect(requests.every((request) => request.ownerId === "owner-1")).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP Review Approval Provider rejects malformed decisions and actor drift", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ approved: true, actorId: "different-owner" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("approval test server did not bind");

  try {
    const provider = createHttpReviewApprovalProvider({
      origin: `http://127.0.0.1:${address.port}`,
      ownerId: "owner-1",
    });
    await expect(provider.approveEffect("effect-1")).rejects.toThrow("actorId");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
