from __future__ import annotations

import json
import threading
from uuid import uuid4
from typing import Any

from services.reimbursement.app.audit import AuditEvent, AuditService
from services.runtime.app.model_provider import ModelRequest, ModelResponse, ModelToolCall
from services.runtime.app.harness_runtime import HarnessModelCallResult

from .harness_client import HarnessHostClient, HarnessRun, ProductTask, result_payload


class HostHarnessRuntime:
    """Compatibility adapter for synchronous business planning seams.

    The old Crew decomposition/matching/drafting services consume the small
    ``AnnaHarnessRuntime.call_model`` shape. This adapter keeps those business
    rules and response validation intact while making the actual model decision
    a whole task owned by the Node Host. It is intentionally synchronous because
    the API routes call planning work from a worker thread.
    """

    def __init__(
        self,
        client: HarnessHostClient,
        *,
        surface: str = "crew",
        default_workspace_id: str = "business-planning",
        default_actor_user_id: str = "business-planning",
    ) -> None:
        self.client = client
        self.surface = surface
        self.audit = AuditService()
        self._default_workspace_id = default_workspace_id
        self._default_actor_user_id = default_actor_user_id
        self._scope_hints: dict[str, tuple[str, str]] = {}
        self._scope_lock = threading.Lock()

    def bind_scope(self, run_id: str, workspace_id: str, actor_user_id: str) -> None:
        """Bind the authenticated product scope for a planning task."""
        with self._scope_lock:
            self._scope_hints[run_id] = (workspace_id, actor_user_id)

    def call_model(
        self,
        run_id: str,
        audit_events: list[AuditEvent],
        request: ModelRequest,
        started_payload: dict[str, Any] | None = None,
        config_error_message: str = "Harness Host is required for business planning",
    ) -> HarnessModelCallResult:
        system_prompt = _message_content(request.messages, "system")
        prompt = _message_content(request.messages, "user")
        context = {
            "business_mode": True,
            "planning": True,
            "source_run_id": run_id,
            "tool_catalog": request.tools,
        }
        with self._scope_lock:
            workspace_id, actor_user_id = self._scope_hints.pop(
                run_id,
                (self._default_workspace_id, self._default_actor_user_id),
            )
        host_run_id = f"{run_id}:host:{uuid4().hex[:12]}"
        task = ProductTask(
            run_id=host_run_id,
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            surface=self.surface,  # validated by ProductTask
            prompt=prompt or system_prompt or "完成业务规划",
            conversation_id=f"business:{run_id}",
            system_prompt=system_prompt,
            context=context,
            permission_mode="readonly",
        )
        try:
            run = self.client.submit_and_wait(task)
        except Exception as exc:  # Host errors become honest model failures.
            self.audit.append(
                audit_events,
                "harness.task.failed",
                run_id,
                {"error_code": getattr(exc, "code", None) or "harness_request_failed"},
            )
            return HarnessModelCallResult(
                error_code=getattr(exc, "code", None) or "harness_request_failed",
                message=config_error_message,
            )

        if run.status not in {"completed", "succeeded"}:
            return HarnessModelCallResult(
                error_code=_result_error_code(run) or "harness_task_failed",
                message=_result_error_message(run) or "Harness Host business task failed",
            )
        result = result_payload(run)
        try:
            response = _model_response(result, request.tools, run.events)
        except ValueError as exc:
            self.audit.append(
                audit_events,
                "harness.task.failed",
                run_id,
                {"error_code": "harness_result_invalid"},
            )
            return HarnessModelCallResult(
                error_code="harness_result_invalid",
                message=str(exc),
            )
        self.audit.append(
            audit_events,
            "harness.task.completed",
            run_id,
            {
                "surface": self.surface,
                "tool_call_count": len(response.tool_calls),
                "requested_tool_names": [call.name for call in response.tool_calls],
            },
        )
        return HarnessModelCallResult(response=response)


def _message_content(messages: list[dict[str, Any]], role: str) -> str:
    values = [
        message.get("content")
        for message in messages
        if message.get("role") == role and isinstance(message.get("content"), str)
    ]
    return "\n\n".join(values)


def _model_response(
    result: dict[str, Any],
    offered_tools: list[dict[str, Any]],
    events: tuple[dict[str, Any], ...] = (),
) -> ModelResponse:
    raw_calls = result.get("tool_calls")
    if raw_calls is None:
        raw_calls = result.get("toolCalls", [])
    if raw_calls is None:
        raw_calls = []
    if not isinstance(raw_calls, list):
        raise ValueError("Harness result tool_calls must be a list")
    offered = {str(item.get("name")) for item in offered_tools if isinstance(item, dict)}
    successful_ids, responded_ids = _successful_tool_call_ids(events)
    calls: list[ModelToolCall] = []
    for index, raw in enumerate(raw_calls):
        if not isinstance(raw, dict):
            raise ValueError("Harness result tool call must be an object")
        function = raw.get("function")
        if isinstance(function, dict):
            name = function.get("name")
            arguments = function.get("arguments", {})
        else:
            name = raw.get("name")
            arguments = raw.get("arguments", {})
        if not isinstance(name, str) or not name:
            raise ValueError("Harness result tool call omitted name")
        # The Host may return provider-safe names (crew__emit...), while the
        # Python registry speaks the canonical dotted names.
        canonical = name.replace("__", ".")
        # ``todo`` is a native Host/OMP tool. It is part of the canonical Host
        # trace, but it is not a Crew proposal for this legacy projection.
        if canonical == "todo":
            continue
        if canonical not in offered and name not in offered:
            continue
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError as exc:
                raise ValueError("Harness result tool arguments were invalid JSON") from exc
        if not isinstance(arguments, dict):
            raise ValueError("Harness result tool arguments must be an object")
        call_id = str(raw.get("id") or f"host_call_{index + 1}")
        if responded_ids and call_id not in successful_ids:
            continue
        calls.append(
            ModelToolCall(
                id=call_id,
                name=canonical,
                arguments=dict(arguments),
            )
        )
    assistant_message = result.get("assistant_message")
    if assistant_message is None:
        assistant_message = result.get("answer")
    if assistant_message is not None and not isinstance(assistant_message, str):
        raise ValueError("Harness result assistant_message must be a string")
    finish_reason = result.get("finish_reason")
    if finish_reason is not None and not isinstance(finish_reason, str):
        finish_reason = str(finish_reason)
    return ModelResponse(
        assistant_message=assistant_message,
        tool_calls=calls,
        finish_reason=finish_reason,
        input_tokens=_optional_int(result.get("input_tokens")),
        output_tokens=_optional_int(result.get("output_tokens")),
    )


def _successful_tool_call_ids(
    events: tuple[dict[str, Any], ...],
) -> tuple[set[str], set[str]]:
    successful: set[str] = set()
    responded: set[str] = set()
    for event in events:
        if event.get("type") != "omp.tool.response" or not isinstance(event.get("payload"), dict):
            continue
        payload = event["payload"]
        call_id = payload.get("toolCallId") or payload.get("tool_call_id")
        result = payload.get("result")
        if not isinstance(call_id, str) or not isinstance(result, dict):
            continue
        responded.add(call_id)
        if result.get("status") == "succeeded":
            successful.add(call_id)
    return successful, responded


def _result_error_code(run: HarnessRun) -> str | None:
    result = run.result or {}
    for key in ("error_code", "code", "error"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _result_error_message(run: HarnessRun) -> str | None:
    result = run.result or {}
    for key in ("error_message", "message", "error"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None
