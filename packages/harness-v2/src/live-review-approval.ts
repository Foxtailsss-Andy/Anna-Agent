import type {
  ReviewApprovalDecision,
  ReviewApprovalProvider,
  ReviewLaneOutput,
} from "./review-to-validated-patch";

export interface HttpReviewApprovalProviderOptions {
  readonly origin: string;
  readonly ownerId: string;
  readonly fetchImpl?: typeof fetch;
}

export function createHttpReviewApprovalProvider(
  options: HttpReviewApprovalProviderOptions,
): ReviewApprovalProvider {
  const origin = normalizeOrigin(options.origin);
  const ownerId = nonEmpty(options.ownerId, "ownerId");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    confirmMemoryCandidate(candidate) {
      return request(fetchImpl, origin, ownerId, {
        action: "confirm_memory_candidate",
        traceId: candidate.traceId,
        candidate: {
          id: candidate.id,
          content: candidate.content,
          sourceRunId: candidate.sourceRunId,
          sourceEventIds: [...candidate.sourceEventIds],
        },
      });
    },
    approveLane(lane) {
      return request(fetchImpl, origin, ownerId, {
        action: "approve_lane",
        traceId: lane.traceId,
        lane: {
          id: lane.id,
          lane: lane.lane,
          kind: lane.kind,
          targetPath: lane.targetPath,
          artifactIds: [
            lane.artifact?.id,
            lane.uiBuild?.id,
            lane.screenshot?.id,
          ].filter((id): id is string => id !== undefined),
          artifactHashes: [
            lane.artifact?.hash,
            lane.uiBuild?.hash,
            lane.screenshot?.hash,
          ].filter((hash): hash is string => hash !== undefined),
        },
      });
    },
    approveEffect(effectKey) {
      return request(fetchImpl, origin, ownerId, {
        action: "approve_effect",
        effectKey: nonEmpty(effectKey, "effectKey"),
      });
    },
  };
}

function normalizeOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("Review approval origin must be an absolute URL");
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Review approval origin must not contain credentials or query state");
  }
  return parsed.toString().replace(/\/$/, "");
}

async function request(
  fetchImpl: typeof fetch,
  origin: string,
  ownerId: string,
  subject: Record<string, unknown>,
): Promise<ReviewApprovalDecision> {
  const response = await fetchImpl(`${origin}/decisions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-anna-owner-id": ownerId,
    },
    body: JSON.stringify({ ownerId, ...subject }),
  });
  if (!response.ok) {
    throw new Error(`Review approval provider returned HTTP ${response.status}`);
  }
  const body = await response.json().catch(() => undefined) as {
    approved?: unknown;
    actorId?: unknown;
  } | undefined;
  if (body?.approved !== true && body?.approved !== false) {
    throw new Error("Review approval provider returned an invalid approved decision");
  }
  if (typeof body.actorId !== "string" || body.actorId.trim() === "") {
    throw new Error("Review approval provider returned an invalid actorId");
  }
  if (body.actorId !== ownerId) {
    throw new Error("Review approval provider actorId does not match ownerId");
  }
  return { approved: body.approved, actorId: body.actorId };
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}
