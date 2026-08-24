import type { CanonicalEvent, ChannelScope } from "./contracts";
import {
  acceptedCandidate,
  deletedCandidate,
  deletedMemory as deletedMemoryEvent,
  editedCandidate,
  editedMemory,
  proposedCandidate,
  rejectedCandidate,
  workspaceReadGranted,
  workspaceReadRevoked,
  type StoredAcceptance,
  type StoredCandidate,
  type StoredCandidateDeletion,
  type StoredCandidateEdit,
  type StoredDeletion,
  type StoredEdit,
  type StoredWorkspaceReadGrant,
} from "./memory-events";
import type {
  AcceptedChannelMemory,
  DeletedChannelMemory,
  DeletedMemoryCandidate,
} from "./memory-types";

export function retrieveAcceptedMemories(
  events: readonly CanonicalEvent[],
  scope: ChannelScope,
  queryTokens: readonly string[],
): AcceptedChannelMemory[] {
  return events.flatMap((event) => {
    const candidate = proposedCandidate(event);
    if (candidate === undefined) {
      return [];
    }

    const acceptance = acceptedMemory(events, candidate.id);
    const deletion = deletedMemory(events, candidate.id);
    const edit = latestEditedMemory(events, candidate.id)
      ?? latestEditedCandidate(events, candidate.id);
    const content = edit?.content ?? candidate.content;
    if (
      acceptance === undefined
      || deletion !== undefined
      || !queryTokens.every((token) => content.toLowerCase().includes(token))
    ) {
      return [];
    }

    return [{
      id: candidate.id,
      content,
      sourceRunId: candidate.sourceRunId,
      sourceEventIds: [...candidate.sourceEventIds],
      sourceChannel: {
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
      },
      acceptedBy: acceptance.actorId,
      acceptedEventId: acceptance.eventId,
      acceptedAt: acceptance.timestamp,
      ...(edit === undefined ? {} : {
        editedBy: edit.actorId,
        editedEventId: edit.eventId,
        editedAt: edit.timestamp,
      }),
    }];
  });
}

export function candidateById(
  events: readonly CanonicalEvent[],
  candidateId: string,
): StoredCandidate | undefined {
  for (const event of events) {
    const candidate = proposedCandidate(event);
    if (candidate?.id === candidateId) {
      return candidate;
    }
  }
  return undefined;
}

export function decisionForCandidate(
  events: readonly CanonicalEvent[],
  candidateId: string,
): StoredAcceptance | StoredCandidateDeletion | undefined {
  for (const event of events) {
    const acceptanceOrRejection = acceptedCandidate(event) ?? rejectedCandidate(event);
    if (acceptanceOrRejection?.candidateId === candidateId) {
      return acceptanceOrRejection;
    }

    const deletion = deletedCandidate(event);
    if (deletion?.candidateId === candidateId) {
      return deletion;
    }
  }
  return undefined;
}

export function acceptedMemory(
  events: readonly CanonicalEvent[],
  memoryId: string,
): StoredAcceptance | undefined {
  for (const event of events) {
    const acceptance = acceptedCandidate(event);
    if (acceptance?.candidateId === memoryId) {
      return acceptance;
    }
    if (rejectedCandidate(event)?.candidateId === memoryId) {
      return undefined;
    }
  }
  return undefined;
}

export function deletedMemory(
  events: readonly CanonicalEvent[],
  memoryId: string,
): StoredDeletion | undefined {
  let deletion: StoredDeletion | undefined;
  for (const event of events) {
    const candidate = deletedMemoryEvent(event);
    if (candidate?.memoryId === memoryId) {
      deletion = candidate;
    }
  }
  return deletion;
}

export function candidateDeletion(
  events: readonly CanonicalEvent[],
  candidateId: string,
): StoredCandidateDeletion | undefined {
  for (const event of events) {
    const deletion = deletedCandidate(event);
    if (deletion?.candidateId === candidateId) {
      return deletion;
    }
  }
  return undefined;
}

export function latestEditedMemory(
  events: readonly CanonicalEvent[],
  memoryId: string,
): StoredEdit | undefined {
  let edit: StoredEdit | undefined;
  for (const event of events) {
    const candidate = editedMemory(event);
    if (candidate?.memoryId === memoryId) {
      edit = candidate;
    }
  }
  return edit;
}

export function latestEditedCandidate(
  events: readonly CanonicalEvent[],
  candidateId: string,
): StoredCandidateEdit | undefined {
  let edit: StoredCandidateEdit | undefined;
  for (const event of events) {
    const candidate = editedCandidate(event);
    if (candidate?.candidateId === candidateId) {
      edit = candidate;
    }
  }
  return edit;
}

export function workspaceReadGrantById(
  events: readonly CanonicalEvent[],
  grantId: string,
): StoredWorkspaceReadGrant | undefined {
  for (const event of events) {
    const grant = workspaceReadGranted(event);
    if (grant?.grantId === grantId) {
      return grant;
    }
  }
  return undefined;
}

export function activeWorkspaceReadGrants(
  events: readonly CanonicalEvent[],
): StoredWorkspaceReadGrant[] {
  return events.flatMap((event, index) => {
    const grant = workspaceReadGranted(event);
    if (
      grant === undefined
      || events.slice(0, index).some((prior) => workspaceReadGranted(prior)?.grantId === grant.grantId)
      || events.slice(index + 1).some((later) => {
        const revocation = workspaceReadRevoked(later);
        return revocation?.grantId === grant.grantId
          && revocation.targetChannelId === grant.targetChannelId;
      })
    ) {
      return [];
    }
    return [grant];
  });
}

export function deletedChannelMemory(
  events: readonly CanonicalEvent[],
  scope: ChannelScope,
  memoryId: string,
): DeletedChannelMemory | undefined {
  const candidate = candidateById(events, memoryId);
  const acceptance = acceptedMemory(events, memoryId);
  const deletion = deletedMemory(events, memoryId);
  if (candidate === undefined || acceptance === undefined || deletion === undefined) {
    return undefined;
  }

  return {
    status: "deleted",
    id: candidate.id,
    sourceRunId: candidate.sourceRunId,
    sourceEventIds: [...candidate.sourceEventIds],
    sourceChannel: {
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
    },
    acceptedBy: acceptance.actorId,
    acceptedEventId: acceptance.eventId,
    acceptedAt: acceptance.timestamp,
    deletedBy: deletion.actorId,
    deletedEventId: deletion.eventId,
    deletedAt: deletion.timestamp,
  };
}

export function deletedMemoryCandidate(
  events: readonly CanonicalEvent[],
  scope: ChannelScope,
  candidateId: string,
): DeletedMemoryCandidate | undefined {
  const candidate = candidateById(events, candidateId);
  const deletion = candidateDeletion(events, candidateId);
  const decision = decisionForCandidate(events, candidateId);
  if (
    candidate === undefined
    || deletion === undefined
    || decision?.eventId !== deletion.eventId
  ) {
    return undefined;
  }

  return {
    status: "candidate_deleted",
    id: candidate.id,
    sourceRunId: candidate.sourceRunId,
    sourceEventIds: [...candidate.sourceEventIds],
    sourceChannel: {
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
    },
    deletedBy: deletion.actorId,
    deletedEventId: deletion.eventId,
    deletedAt: deletion.timestamp,
  };
}
