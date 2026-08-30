import { parseJsonValue } from "./contracts";
import type { DurableToolGateway, ToolRequest, ToolResult } from "./interfaces";
import {
  appendApprovalAnswer,
  appendApprovalRequest,
  approvalFor,
} from "./tool-approval";
import { executeEffect } from "./tool-effects";
import {
  appendToolLifecycleEvent,
  lifecycleRequestFor,
  readStreamEvents,
  runAttributionPayload,
  terminalResult,
} from "./tool-events";
import {
  snapshotOptions,
  type ToolGatewayOptions,
} from "./tool-gateway-types";

export type {
  ToolDefinition,
  ToolGatewayOptions,
  ToolPolicy,
} from "./tool-gateway-types";

export function createToolGateway(
  options: ToolGatewayOptions,
): DurableToolGateway {
  const boundOptions = snapshotOptions(options);

  return {
    async execute(request, signal) {
      const lifecycleRequest = lifecycleRequestFor(boundOptions, request);
      if (lifecycleRequest === undefined) {
        return { status: "failed", output: { reason: "invalid_tool_call_id" } };
      }
      await appendToolLifecycleEvent(
        boundOptions,
        lifecycleRequest,
        "tool.requested",
      );

      if (
        request.workspaceId !== boundOptions.scope.workspaceId ||
        request.channelId !== boundOptions.scope.channelId ||
        request.workerProfileId !== boundOptions.workerProfileId
      ) {
        return terminalResult(
          boundOptions,
          lifecycleRequest,
          { status: "failed", output: { reason: "scope_denied" } },
        );
      }

      const definition = boundOptions.catalog.find(
        (candidate) => candidate.name === request.name,
      );
      if (definition === undefined) {
        return terminalResult(
          boundOptions,
          lifecycleRequest,
          { status: "failed" },
          "unregistered_tool",
        );
      }

      let normalizedInput;
      try {
        normalizedInput = parseJsonValue(
          definition.inputSchema.parse(request.input),
          "ToolRequest.input",
        );
      } catch {
        return terminalResult(
          boundOptions,
          lifecycleRequest,
          { status: "failed", output: { reason: "invalid_tool_input" } },
        );
      }

      const normalizedRequest: ToolRequest = {
        workspaceId: boundOptions.scope.workspaceId,
        channelId: boundOptions.scope.channelId,
        runId: request.runId,
        workerProfileId: boundOptions.workerProfileId,
        name: request.name,
        input: normalizedInput,
        ...(request.effectKey === undefined ? {} : { effectKey: request.effectKey }),
        toolCallId: request.toolCallId,
        ...runAttributionPayload(request),
      };

      if (boundOptions.policy === undefined) {
        return terminalResult(
          boundOptions,
          lifecycleRequest,
          { status: "failed", output: { reason: "policy_unavailable" } },
        );
      }

      let decision: "allow" | "deny" | "require_approval";
      try {
        decision = await boundOptions.policy.decide(normalizedRequest);
      } catch {
        return terminalResult(
          boundOptions,
          lifecycleRequest,
          { status: "failed", output: { reason: "policy_unavailable" } },
        );
      }
      if (
        decision !== "allow" &&
        decision !== "deny" &&
        decision !== "require_approval"
      ) {
        return terminalResult(
          boundOptions,
          lifecycleRequest,
          { status: "failed", output: { reason: "invalid_policy_decision" } },
        );
      }
      await appendToolLifecycleEvent(
        boundOptions,
        lifecycleRequest,
        "tool.policy.decided",
        { decision },
      );
      if (decision === "deny") {
        return terminalResult(
          boundOptions,
          lifecycleRequest,
          { status: "failed" },
          "policy_denied",
        );
      }

      if (decision === "allow") {
        if (
          definition.replayPolicy === "safe" &&
          normalizedRequest.effectKey === undefined
        ) {
          const result = await boundOptions.sandbox.execute(normalizedRequest, signal);
          return terminalResult(boundOptions, lifecycleRequest, result);
        }
        if (
          (definition.replayPolicy === "safe" || definition.replayPolicy === "never") &&
          typeof normalizedRequest.effectKey === "string" &&
          normalizedRequest.effectKey.length > 0
        ) {
          const effectOptions = {
            ...boundOptions,
            sandbox: {
              async execute(request: ToolRequest, effectSignal: AbortSignal): Promise<ToolResult> {
                if (effectSignal.aborted) {
                  return {
                    status: "failed",
                    output: { reason: "cancelled" },
                  };
                }
                return boundOptions.sandbox.execute(request, effectSignal);
              },
            },
          };
          const result = await executeEffect(
            effectOptions,
            normalizedRequest,
            definition.replayPolicy,
            signal,
          );
          return terminalResult(boundOptions, lifecycleRequest, result);
        }
      }

      if (
        decision !== "require_approval" ||
        normalizedRequest.effectKey === undefined ||
        normalizedRequest.effectKey.length === 0
      ) {
        return terminalResult(
          boundOptions,
          lifecycleRequest,
          { status: "failed", output: { reason: "invalid_tool_combination" } },
        );
      }

      const approvalId = `approval:${normalizedRequest.effectKey}`;
      const durableEvents = await readStreamEvents(
        boundOptions.events,
        normalizedRequest.runId as never,
      );
      const approval = approvalFor(durableEvents, normalizedRequest, approvalId);
      if (approval.decision === "approved") {
        const result = definition.replayPolicy !== undefined
          ? await executeEffect(
              boundOptions,
              normalizedRequest,
              definition.replayPolicy,
              signal,
            )
          : await boundOptions.sandbox.execute(normalizedRequest, signal);
        return terminalResult(boundOptions, lifecycleRequest, result);
      }

      if (approval.decision === "denied") {
        const result: ToolResult = {
          status: "failed",
          output: { reason: "approval_denied", approvalId },
        };
        return terminalResult(boundOptions, lifecycleRequest, result);
      }

      if (approval.request === undefined) {
        await appendApprovalRequest(
          boundOptions,
          normalizedRequest,
          approvalId,
          durableEvents,
        );
      }

      return terminalResult(boundOptions, lifecycleRequest, {
        status: "failed",
        output: { reason: "approval_required", approvalId },
      });
    },

    async answerApproval(answer) {
      if (
        answer.workspaceId !== boundOptions.scope.workspaceId ||
        answer.channelId !== boundOptions.scope.channelId
      ) {
        throw new Error("Tool approval answer is outside the bound scope");
      }

      await appendApprovalAnswer(boundOptions, answer);
    },
  };
}
