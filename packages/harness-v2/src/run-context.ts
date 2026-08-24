import {
  parseJsonValue,
  type ChannelScope,
  type RunId,
  type WorkerProfileId,
} from "./contracts";
import type { ToolRequest } from "./interfaces";
import {
  expectNonEmptyString,
  expectRecord,
  SchemaValidationError,
} from "./schema";

export interface RunContextProvenance {
  readonly source: string;
  readonly sourceEventIds: readonly string[];
}

export interface RunContextText {
  readonly content: string;
  readonly provenance: RunContextProvenance;
}

export interface RunContextMessage extends RunContextText {
  readonly role: string;
}

export interface PendingToolCall extends ToolRequest {
  readonly provenance: RunContextProvenance;
}

export interface RunContextMemoryHit extends RunContextText {
  readonly memoryId: string;
}

export interface RunContext extends ChannelScope {
  readonly runId: RunId;
  readonly workerProfileId: WorkerProfileId;
  readonly goal: RunContextText;
  readonly constraints: readonly RunContextText[];
  readonly transientMessages: readonly RunContextMessage[];
  readonly pendingToolCalls: readonly PendingToolCall[];
  readonly memoryHits: readonly RunContextMemoryHit[];
}

export interface RunContextSummary {
  readonly summary: string;
}

type RunContextBinding = Pick<
  RunContext,
  "workspaceId" | "channelId" | "runId" | "workerProfileId"
>;

function expectArray(input: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new SchemaValidationError(`${name} must be an array`);
  }

  return input;
}

function parseProvenance(input: unknown, name: string): RunContextProvenance {
  const value = expectRecord(input, name);
  const sourceEventIds = expectArray(value.sourceEventIds, `${name}.sourceEventIds`);
  if (sourceEventIds.length === 0) {
    throw new SchemaValidationError(`${name}.sourceEventIds must contain provenance`);
  }

  return Object.freeze({
    source: expectNonEmptyString(value.source, `${name}.source`),
    sourceEventIds: Object.freeze(
      sourceEventIds.map((eventId, index) =>
        expectNonEmptyString(eventId, `${name}.sourceEventIds[${index}]`),
      ),
    ),
  });
}

function parseText(input: unknown, name: string): RunContextText {
  const value = expectRecord(input, name);

  return Object.freeze({
    content: expectNonEmptyString(value.content, `${name}.content`),
    provenance: parseProvenance(value.provenance, `${name}.provenance`),
  });
}

function parseMessages(input: unknown): readonly RunContextMessage[] {
  return Object.freeze(
    expectArray(input, "RunContext.transientMessages").map((message, index) => {
      const value = expectRecord(message, `RunContext.transientMessages[${index}]`);

      return Object.freeze({
        role: expectNonEmptyString(
          value.role,
          `RunContext.transientMessages[${index}].role`,
        ),
        content: expectNonEmptyString(
          value.content,
          `RunContext.transientMessages[${index}].content`,
        ),
        provenance: parseProvenance(
          value.provenance,
          `RunContext.transientMessages[${index}].provenance`,
        ),
      });
    }),
  );
}

function parsePendingToolCalls(
  input: unknown,
  binding: RunContextBinding,
): readonly PendingToolCall[] {
  return Object.freeze(
    expectArray(input, "RunContext.pendingToolCalls").map((toolCall, index) => {
      const value = expectRecord(toolCall, `RunContext.pendingToolCalls[${index}]`);
      const name = `RunContext.pendingToolCalls[${index}]`;
      const parsed: PendingToolCall = {
        workspaceId: expectNonEmptyString(
          value.workspaceId,
          `${name}.workspaceId`,
        ) as ChannelScope["workspaceId"],
        channelId: expectNonEmptyString(
          value.channelId,
          `${name}.channelId`,
        ) as ChannelScope["channelId"],
        runId: expectNonEmptyString(value.runId, `${name}.runId`) as RunId,
        workerProfileId: expectNonEmptyString(
          value.workerProfileId,
          `${name}.workerProfileId`,
        ) as WorkerProfileId,
        name: expectNonEmptyString(value.name, `${name}.name`),
        input: deepFreeze(parseJsonValue(value.input, `${name}.input`)),
        ...(value.effectKey === undefined
          ? {}
          : { effectKey: expectNonEmptyString(value.effectKey, `${name}.effectKey`) }),
        toolCallId: expectNonEmptyString(value.toolCallId, `${name}.toolCallId`),
        provenance: parseProvenance(value.provenance, `${name}.provenance`),
      };

      if (
        parsed.workspaceId !== binding.workspaceId ||
        parsed.channelId !== binding.channelId ||
        parsed.runId !== binding.runId ||
        parsed.workerProfileId !== binding.workerProfileId
      ) {
        throw new SchemaValidationError(
          "RunContext pending Tool call must match its bound scope, Run, and Worker",
        );
      }

      return Object.freeze(parsed);
    }),
  );
}

function parseMemoryHits(input: unknown): readonly RunContextMemoryHit[] {
  return Object.freeze(
    expectArray(input, "RunContext.memoryHits").map((memoryHit, index) => {
      const value = expectRecord(memoryHit, `RunContext.memoryHits[${index}]`);

      return Object.freeze({
        memoryId: expectNonEmptyString(
          value.memoryId,
          `RunContext.memoryHits[${index}].memoryId`,
        ),
        content: expectNonEmptyString(
          value.content,
          `RunContext.memoryHits[${index}].content`,
        ),
        provenance: parseProvenance(
          value.provenance,
          `RunContext.memoryHits[${index}].provenance`,
        ),
      });
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
}

export function buildRunContext(input: unknown): RunContext {
  const value = expectRecord(input, "RunContext");
  const binding: RunContextBinding = Object.freeze({
    workspaceId: expectNonEmptyString(
      value.workspaceId,
      "RunContext.workspaceId",
    ) as ChannelScope["workspaceId"],
    channelId: expectNonEmptyString(
      value.channelId,
      "RunContext.channelId",
    ) as ChannelScope["channelId"],
    runId: expectNonEmptyString(value.runId, "RunContext.runId") as RunId,
    workerProfileId: expectNonEmptyString(
      value.workerProfileId,
      "RunContext.workerProfileId",
    ) as WorkerProfileId,
  });

  return Object.freeze({
    ...binding,
    goal: parseText(value.goal, "RunContext.goal"),
    constraints: Object.freeze(
      expectArray(value.constraints, "RunContext.constraints").map((constraint, index) =>
        parseText(constraint, `RunContext.constraints[${index}]`),
      ),
    ),
    transientMessages: parseMessages(value.transientMessages),
    pendingToolCalls: parsePendingToolCalls(value.pendingToolCalls, binding),
    memoryHits: parseMemoryHits(value.memoryHits),
  });
}

export function compactRunContext(
  context: RunContext,
  summary: RunContextSummary,
): RunContext {
  const sourceEventIds = [
    ...new Set([
      ...context.goal.provenance.sourceEventIds,
      ...context.constraints.flatMap((constraint) => constraint.provenance.sourceEventIds),
      ...context.transientMessages.flatMap((message) => message.provenance.sourceEventIds),
      ...context.pendingToolCalls.flatMap((toolCall) => toolCall.provenance.sourceEventIds),
      ...context.memoryHits.flatMap((memoryHit) => memoryHit.provenance.sourceEventIds),
    ]),
  ];

  return buildRunContext({
    ...context,
    transientMessages: [
      {
        role: "summary",
        content: expectNonEmptyString(summary?.summary, "RunContextSummary.summary"),
        provenance: {
          source: "compaction",
          sourceEventIds,
        },
      },
    ],
  });
}
