import type { ActorId, ChannelScope } from "./contracts";
import type { EventStore } from "./interfaces";
import type { ResolvedRunProfile } from "./run-profile";

export interface MemoryCandidateProposal {
  readonly id: string;
  readonly content: string;
  readonly sourceEventIds: readonly string[];
  readonly sourceRunId: string;
}

export interface MemoryCandidateEdit {
  readonly candidateId: string;
  readonly content: string;
  readonly actorId: string;
}

export interface MemoryCandidateDeletion {
  readonly candidateId: string;
  readonly actorId: string;
}

export interface MemoryAcceptance {
  readonly candidateId: string;
  readonly actorId: string;
}

export interface MemoryRejection {
  readonly candidateId: string;
  readonly actorId: string;
}

export interface MemoryEdit {
  readonly memoryId: string;
  readonly content: string;
  readonly actorId: string;
}

export interface MemoryDeletion {
  readonly memoryId: string;
  readonly actorId: string;
}

export interface MemoryRetrieval {
  readonly query: string;
  readonly limit: number;
  readonly runId?: string;
  readonly workspaceGrantRefs?: readonly WorkspaceMemoryGrantReference[];
}

export interface WorkspaceMemoryGrantReference {
  readonly grantId: string;
  readonly sourceChannelId: string;
}

export interface WorkspaceReadGrant {
  readonly grantId: string;
  readonly targetChannelId: string;
  readonly actorId: string;
}

export interface WorkspaceReadRevocation {
  readonly grantId: string;
  readonly actorId: string;
}

export interface WorkspaceMemoryGrantProvenance {
  readonly grantId: string;
  readonly grantedBy: string;
  readonly grantEventId: string;
  readonly grantedAt: string;
}

export interface AcceptedChannelMemory {
  readonly id: string;
  readonly content: string;
  readonly sourceRunId: string;
  readonly sourceEventIds: string[];
  readonly sourceChannel: {
    readonly workspaceId: string;
    readonly channelId: string;
  };
  readonly acceptedBy: string;
  readonly acceptedEventId: string;
  readonly acceptedAt: string;
  readonly editedBy?: string;
  readonly editedEventId?: string;
  readonly editedAt?: string;
  readonly workspaceGrant?: WorkspaceMemoryGrantProvenance;
}

export interface DeletedChannelMemory {
  readonly status: "deleted";
  readonly id: string;
  readonly sourceRunId: string;
  readonly sourceEventIds: string[];
  readonly sourceChannel: {
    readonly workspaceId: string;
    readonly channelId: string;
  };
  readonly acceptedBy: string;
  readonly acceptedEventId: string;
  readonly acceptedAt: string;
  readonly deletedBy: string;
  readonly deletedEventId: string;
  readonly deletedAt: string;
}

export interface DeletedMemoryCandidate {
  readonly status: "candidate_deleted";
  readonly id: string;
  readonly sourceRunId: string;
  readonly sourceEventIds: string[];
  readonly sourceChannel: {
    readonly workspaceId: string;
    readonly channelId: string;
  };
  readonly deletedBy: string;
  readonly deletedEventId: string;
  readonly deletedAt: string;
}

export interface ChannelMemoryRepository {
  propose(candidate: MemoryCandidateProposal): Promise<void>;
  editCandidate(edit: MemoryCandidateEdit): Promise<void>;
  deleteCandidate(deletion: MemoryCandidateDeletion): Promise<void>;
  accept(acceptance: MemoryAcceptance): Promise<void>;
  reject(rejection: MemoryRejection): Promise<void>;
  edit(edit: MemoryEdit): Promise<void>;
  delete(deletion: MemoryDeletion): Promise<void>;
  grantWorkspaceRead(grant: WorkspaceReadGrant): Promise<void>;
  revokeWorkspaceRead(revocation: WorkspaceReadRevocation): Promise<void>;
  inspect(memoryId: string): Promise<DeletedChannelMemory | undefined>;
  inspectCandidate(candidateId: string): Promise<DeletedMemoryCandidate | undefined>;
  retrieve(retrieval: MemoryRetrieval): Promise<AcceptedChannelMemory[]>;
}

export interface ChannelOwnerAuthorization {
  assertOwner(scope: Readonly<ChannelScope>, actorId: ActorId | string): Promise<void>;
}

export interface CreateChannelMemoryRepositoryOptions {
  readonly eventStore: EventStore;
  readonly scope: ChannelScope;
  readonly authorization: ChannelOwnerAuthorization;
  readonly runProfileSnapshot: ResolvedRunProfile;
  readonly now?: () => string;
  readonly createEventId?: () => string;
}
