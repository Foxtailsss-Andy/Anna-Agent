from __future__ import annotations

import json
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .mode import BusinessModeConfig


ProductSurface = Literal[
    "chat",
    "create",
    "hiker",
    "reimbursement",
    "crew",
]
PermissionMode = Literal["readonly", "ask", "contained-write", "full"]


class ProductTask(BaseModel):
    """The only task shape the business process may submit to the Host."""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    workspace_id: str
    actor_user_id: str
    surface: ProductSurface
    prompt: str
    channel_id: str | None = None
    conversation_id: str | None = None
    system_prompt: str | None = None
    context: dict[str, Any] = Field(default_factory=dict)
    workdir_path: str | None = None
    permission_mode: PermissionMode = "ask"
    model_profile_id: str | None = None
    source_event_id: str | None = None

    @field_validator("run_id", "workspace_id", "actor_user_id", "prompt")
    @classmethod
    def _non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("task identity and prompt must be non-empty")
        return value

    @field_validator("context")
    @classmethod
    def _json_safe_context(cls, value: dict[str, Any]) -> dict[str, Any]:
        try:
            json.dumps(value, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError("task context must be JSON-safe") from exc
        return value


class HarnessHostError(RuntimeError):
    """A transport, protocol or truthful Host failure."""

    def __init__(self, message: str, *, status_code: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


@dataclass(frozen=True)
class HarnessRun:
    run_id: str
    status: str
    result: dict[str, Any] | None = None
    events: tuple[dict[str, Any], ...] = ()
    raw: dict[str, Any] | None = None

    @property
    def terminal(self) -> bool:
        return self.status in {
            "completed",
            "succeeded",
            "failed",
            "timed_out",
            "cancelled",
            "exhausted",
            "awaiting_input",
            "awaiting_approval",
        }


_NATIVE_TODO_PLAN_STATUS = {
    "pending": "pending",
    "in_progress": "in_progress",
    "completed": "done",
    "abandoned": "pending",
    # The legacy PlanItem contract has no blocked state; keep it open rather
    # than presenting blocked work as complete.
    "blocked": "pending",
}


def native_todo_plan(events: Iterable[Mapping[str, Any]]) -> list[dict[str, str]] | None:
    """Return the latest valid plan represented by a canonical native Todo result.

    Only durable ``omp.transcript.message`` tool results named exactly ``todo``
    are admitted. Other result payloads, including arbitrary ``plan`` fields,
    never become a Chat PlanRail projection.
    """
    latest: list[dict[str, str]] | None = None
    for event in events:
        if event.get("type") != "omp.transcript.message":
            continue
        payload = event.get("payload")
        if not isinstance(payload, Mapping):
            continue
        message = payload.get("message")
        if not isinstance(message, Mapping):
            continue
        if message.get("role") != "toolResult" or message.get("toolName") != "todo":
            continue
        details = message.get("details")
        plan = _native_todo_plan_from_details(details)
        if plan is not None:
            latest = plan
    return latest


def _native_todo_plan_from_details(details: object) -> list[dict[str, str]] | None:
    if not isinstance(details, Mapping):
        return None
    phases = details.get("phases")
    if not isinstance(phases, list):
        return None
    plan: list[dict[str, str]] = []
    for phase_index, phase in enumerate(phases):
        if not isinstance(phase, Mapping) or not isinstance(phase.get("name"), str):
            return None
        tasks = phase.get("tasks")
        if not isinstance(tasks, list):
            return None
        for task_index, task in enumerate(tasks):
            if not isinstance(task, Mapping):
                return None
            content = task.get("content")
            status = task.get("status")
            mapped_status = _NATIVE_TODO_PLAN_STATUS.get(status) if isinstance(status, str) else None
            if not isinstance(content, str) or mapped_status is None:
                return None
            plan.append(
                {
                    "id": f"todo-{phase_index + 1}-{task_index + 1}",
                    "title": f"{content} (abandoned)" if status == "abandoned" else content,
                    "status": mapped_status,
                }
            )
    return plan


def result_payload(run: HarnessRun) -> dict[str, Any]:
    """Project Host result plus canonical events into a small business payload.

    The current Node facade puts a final assistant answer in ``result`` while
    structured artifacts/tool outputs remain in canonical event payloads. The
    business adapters consume both without treating an event's absence as a
    successful artifact.
    """
    result = dict(run.result or {})
    tools = result.get("tools_used")
    if not isinstance(tools, list):
        tools = []
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, list):
        artifacts = []
    for event in run.events:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        tool = payload.get("tool") or payload.get("tool_name")
        if isinstance(tool, str) and tool not in tools:
            tools.append(tool)
        event_result = payload.get("result")
        if not isinstance(event_result, dict):
            continue
        output = event_result.get("output")
        if isinstance(output, dict):
            artifact = output.get("artifact")
            if isinstance(artifact, dict) and artifact not in artifacts:
                artifacts.append(artifact)
        artifact = event_result.get("artifact")
        if isinstance(artifact, dict) and artifact not in artifacts:
            artifacts.append(artifact)
    # Structured proposal tools are represented by OMP transcript events while
    # the Node facade keeps the top-level result intentionally small. Preserve
    # those model-selected arguments for existing Crew validators; this does
    # not promote them to a business mutation.
    tool_calls = result.get("tool_calls")
    if not isinstance(tool_calls, list):
        tool_calls = []
    known_call_ids = {
        str(call.get("id"))
        for call in tool_calls
        if isinstance(call, dict) and call.get("id") is not None
    }
    for event in run.events:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        message = payload.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "toolCall":
                continue
            call_id = block.get("id")
            name = block.get("name")
            if not isinstance(call_id, str) or not isinstance(name, str) or call_id in known_call_ids:
                continue
            arguments = block.get("arguments", {})
            normalized_arguments = dict(arguments) if isinstance(arguments, dict) else {}
            tool_calls.append(
                {"id": call_id, "name": name, "arguments": normalized_arguments}
            )
            known_call_ids.add(call_id)
    if tools:
        result["tools_used"] = tools
    if artifacts:
        result["artifacts"] = artifacts
        result.setdefault("artifact", artifacts[-1])
    plan = native_todo_plan(run.events)
    if plan is not None:
        result["plan"] = plan
    if tool_calls:
        result["tool_calls"] = tool_calls
    return result


class HarnessHostClient:
    """Small, fail-closed client for the internal ``/_harness`` contract.

    Sync methods are intentional: FastAPI sync planning routes call them from
    a worker thread, leaving the event loop available for Host callbacks into
    ``/_business``. Async callers can use ``submit_async``/``get_async`` and
    must keep callback paths out of an event-loop-blocking wait.
    """

    def __init__(
        self,
        config: BusinessModeConfig,
        *,
        transport: httpx.BaseTransport | None = None,
        async_transport: httpx.AsyncBaseTransport | None = None,
        client: httpx.Client | None = None,
        async_client: httpx.AsyncClient | None = None,
        sleep=time.sleep,
        monotonic=time.monotonic,
    ) -> None:
        config.require_enabled()
        assert config.host_origin is not None
        assert config.service_token is not None
        self.config = config
        self.origin = config.host_origin.rstrip("/")
        self._transport = transport
        self._async_transport = async_transport
        self._client = client
        self._async_client = async_client
        self._sleep = sleep
        self._monotonic = monotonic

    def submit(self, task: ProductTask | Mapping[str, Any]) -> HarnessRun:
        payload = _task_payload(task)
        body = self._request_sync("POST", "/_harness/runs", json=payload)
        run_id = _required_run_id(body, expected=payload["run_id"])
        return _run_from_response(run_id, body)

    def get(self, run_id: str) -> HarnessRun:
        body = self._request_sync(
            "GET", f"/_harness/runs/{quote(_path_id(run_id), safe='')}"
        )
        return _run_from_response(run_id, body)

    def events(self, run_id: str, *, after_seq: int = -1) -> list[dict[str, Any]]:
        body = self._request_sync(
            "GET",
            f"/_harness/runs/{quote(_path_id(run_id), safe='')}/events",
            params={"after_seq": int(after_seq)},
        )
        events = body.get("events", []) if isinstance(body, dict) else []
        if not isinstance(events, list) or not all(isinstance(item, dict) for item in events):
            raise HarnessHostError("Harness Host returned an invalid events payload", code="invalid_events")
        return [dict(item) for item in events]

    def stop(self, run_id: str, *, reason: str | None = None) -> HarnessRun:
        body = self._request_sync(
            "POST",
            f"/_harness/runs/{quote(_path_id(run_id), safe='')}/stop",
            json={} if reason is None else {"reason": reason},
        )
        return _run_from_response(run_id, body)

    def signal(
        self,
        run_id: str,
        *,
        kind: Literal["steer", "answer", "approval"],
        payload: dict[str, Any],
    ) -> HarnessRun:
        body = self._request_sync(
            "POST",
            f"/_harness/runs/{quote(_path_id(run_id), safe='')}/signal",
            json={"kind": kind, "payload": payload},
        )
        return _run_from_response(run_id, body)

    def continue_run(self, run_id: str) -> HarnessRun:
        body = self._request_sync(
            "POST",
            f"/_harness/runs/{quote(_path_id(run_id), safe='')}/continue",
            json={},
        )
        return _run_from_response(run_id, body)

    def submit_and_wait(
        self,
        task: ProductTask | Mapping[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> HarnessRun:
        submitted = self.submit(task)
        if submitted.terminal:
            return submitted
        deadline = self._monotonic() + (
            timeout_seconds
            if timeout_seconds is not None
            else self.config.wait_timeout_seconds
        )
        while self._monotonic() < deadline:
            current = self.get(submitted.run_id)
            if current.terminal:
                return current
            self._sleep(self.config.poll_interval_seconds)
        raise HarnessHostError(
            "Harness Host task did not reach a terminal state before the deadline",
            code="harness_wait_timeout",
        )

    def wait(
        self,
        run_id: str,
        *,
        timeout_seconds: float | None = None,
    ) -> HarnessRun:
        """Wait for an already-submitted Host run without submitting twice."""
        deadline = self._monotonic() + (
            timeout_seconds
            if timeout_seconds is not None
            else self.config.wait_timeout_seconds
        )
        while self._monotonic() < deadline:
            current = self.get(run_id)
            if current.terminal:
                return current
            self._sleep(self.config.poll_interval_seconds)
        raise HarnessHostError(
            "Harness Host task did not reach a terminal state before the deadline",
            code="harness_wait_timeout",
        )

    async def submit_async(self, task: ProductTask | Mapping[str, Any]) -> HarnessRun:
        payload = _task_payload(task)
        body = await self._request_async("POST", "/_harness/runs", json=payload)
        run_id = _required_run_id(body, expected=payload["run_id"])
        return _run_from_response(run_id, body)

    async def get_async(self, run_id: str) -> HarnessRun:
        body = await self._request_async(
            "GET", f"/_harness/runs/{quote(_path_id(run_id), safe='')}"
        )
        return _run_from_response(run_id, body)

    async def events_async(self, run_id: str, *, after_seq: int = -1) -> list[dict[str, Any]]:
        body = await self._request_async(
            "GET",
            f"/_harness/runs/{quote(_path_id(run_id), safe='')}/events",
            params={"after_seq": int(after_seq)},
        )
        events = body.get("events", []) if isinstance(body, dict) else []
        if not isinstance(events, list) or not all(isinstance(item, dict) for item in events):
            raise HarnessHostError("Harness Host returned an invalid events payload", code="invalid_events")
        return [dict(item) for item in events]

    async def stop_async(self, run_id: str, *, reason: str | None = None) -> HarnessRun:
        body = await self._request_async(
            "POST",
            f"/_harness/runs/{quote(_path_id(run_id), safe='')}/stop",
            json={} if reason is None else {"reason": reason},
        )
        return _run_from_response(run_id, body)

    def _request_sync(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        close = self._client is None
        client = self._client or httpx.Client(
            timeout=self.config.request_timeout_seconds,
            transport=self._transport,
        )
        try:
            response = client.request(
                method,
                f"{self.origin}{path}",
                headers=self._headers(),
                **kwargs,
            )
        except httpx.HTTPError as exc:
            raise HarnessHostError("Harness Host request failed", code="harness_transport_failed") from exc
        finally:
            if close:
                client.close()
        return _decode_response(response)

    async def _request_async(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        close = self._async_client is None
        client = self._async_client or httpx.AsyncClient(
            timeout=self.config.request_timeout_seconds,
            transport=self._async_transport,
        )
        try:
            response = await client.request(
                method,
                f"{self.origin}{path}",
                headers=self._headers(),
                **kwargs,
            )
        except httpx.HTTPError as exc:
            raise HarnessHostError("Harness Host request failed", code="harness_transport_failed") from exc
        finally:
            if close:
                await client.aclose()
        return _decode_response(response)

    def _headers(self) -> dict[str, str]:
        # Never include the token in an exception or serialized payload.
        assert self.config.service_token is not None
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "x-anna-service-token": self.config.service_token,
        }


def _task_payload(task: ProductTask | Mapping[str, Any]) -> dict[str, Any]:
    parsed = task if isinstance(task, ProductTask) else ProductTask.model_validate(task)
    return parsed.model_dump(mode="json", exclude_none=True)


def _path_id(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise HarnessHostError("run id must be non-empty", code="invalid_run_id")
    return value.strip()


def _required_run_id(body: dict[str, Any], *, expected: str) -> str:
    value = body.get("run_id")
    if value is None and isinstance(body.get("run"), dict):
        value = body["run"].get("run_id") or body["run"].get("id")
    if not isinstance(value, str) or not value.strip():
        raise HarnessHostError("Harness Host response omitted run_id", code="invalid_run_response")
    # A Host may assign its own durable id, but it must return a stable id. The
    # caller's id remains the idempotency key in the task payload.
    return value


def _run_from_response(run_id: str, body: dict[str, Any]) -> HarnessRun:
    candidate = body.get("run") if isinstance(body.get("run"), dict) else body
    status = candidate.get("status") if isinstance(candidate, dict) else None
    if not isinstance(status, str) or not status:
        status = "queued"
    result = body.get("result")
    if result is not None and not isinstance(result, dict):
        raise HarnessHostError("Harness Host returned a non-object result", code="invalid_run_response")
    events = body.get("events", [])
    if not isinstance(events, list) or not all(isinstance(item, dict) for item in events):
        raise HarnessHostError("Harness Host returned invalid run events", code="invalid_run_response")
    return HarnessRun(
        run_id=run_id,
        status=status,
        result=dict(result) if isinstance(result, dict) else None,
        events=tuple(dict(item) for item in events),
        raw=dict(body),
    )


def _decode_response(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError as exc:
        raise HarnessHostError(
            "Harness Host returned invalid JSON",
            status_code=response.status_code,
            code="invalid_json",
        ) from exc
    if not isinstance(body, dict):
        raise HarnessHostError(
            "Harness Host returned a non-object response",
            status_code=response.status_code,
            code="invalid_response",
        )
    if response.status_code < 200 or response.status_code >= 300:
        code = body.get("code") if isinstance(body.get("code"), str) else None
        raise HarnessHostError(
            "Harness Host rejected the request",
            status_code=response.status_code,
            code=code,
        )
    return body
