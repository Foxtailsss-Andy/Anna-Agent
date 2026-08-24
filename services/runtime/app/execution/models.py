from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


ExecutionStatus = Literal[
    "queued",
    "running",
    "awaiting_signal",
    "succeeded",
    "failed",
    "cancelled",
]
SignalKind = Literal["steer", "answer", "approval"]

TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
ACTIVE_STATUSES = frozenset({"queued", "running", "awaiting_signal"})
ALLOWED_LOOP_STATUSES = frozenset(
    {"queued", "running", "awaiting_signal", "succeeded", "failed"}
)


@dataclass(frozen=True)
class StartExecution:
    request_id: str
    workspace_id: str
    conversation_id: str
    channel_id: str
    subject_ref: str
    trigger_ref: str
    worker_profile_ref: str
    run_profile_ref: str
    input: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SignalExecution:
    request_id: str
    workspace_id: str
    execution_id: str
    kind: SignalKind
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CancelExecution:
    request_id: str
    workspace_id: str
    execution_id: str
    reason: str


@dataclass(frozen=True)
class RedriveExecution:
    request_id: str
    workspace_id: str
    execution_id: str
    reason: str


ExecutionCommand = StartExecution | SignalExecution | CancelExecution | RedriveExecution


@dataclass(frozen=True)
class ExecutionEvent:
    execution_id: str
    seq: int
    type: str
    payload: dict[str, Any]
    created_at: float


@dataclass(frozen=True)
class PendingSignal:
    signal_id: str
    execution_id: str
    kind: SignalKind
    payload: dict[str, Any]
    created_at: float


@dataclass(frozen=True)
class ExecutionSnapshot:
    execution_id: str
    workspace_id: str
    conversation_id: str
    channel_id: str
    subject_ref: str
    trigger_ref: str
    status: ExecutionStatus
    worker_profile_ref: str
    run_profile_ref: str
    input: dict[str, Any]
    state: dict[str, Any]
    checkpoint: dict[str, Any]
    version: int
    created_at: float
    updated_at: float
    attempt: int = 0
    lease_owner: str | None = None
    lease_token: int = 0
    lease_expires_at: float | None = None
    not_before: float | None = None
    last_error_code: str | None = None
    linked_execution_id: str | None = None
    redrive_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ExecutionLease:
    execution_id: str
    owner_id: str
    lease_token: int
    attempt: int
    lease_expires_at: float


@dataclass(frozen=True)
class LoopResult:
    status: ExecutionStatus = "running"
    state: dict[str, Any] = field(default_factory=dict)
    checkpoint: dict[str, Any] = field(default_factory=dict)
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    applied_signal_ids: list[str] = field(default_factory=list)
    last_error_code: str | None = None
    error_message: str | None = None
    retryable: bool = False
    safe_to_retry: bool = False
    retry_after_seconds: float | None = None
