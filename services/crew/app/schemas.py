from __future__ import annotations

from typing import Any, Literal, Self

from pydantic import BaseModel, Field, model_validator

TaskStatus = Literal[
    "todo", "assigned", "running", "submitted", "in_review",
    "rework", "done", "blocked",
]


class ArtifactVersion(BaseModel):
    """One submitted revision of a task's deliverable (B4).

    Appended on every submit (human or Agent); ``version`` is 1-based and
    monotonic. A rework re-submit appends the next version rather than
    overwriting — the review drawer reads the full history, while the flat
    ``CrewTask.artifact`` field mirrors the LATEST version's content for every
    existing reader."""
    version: int
    content: str
    submitted_at: str


class CrewTask(BaseModel):
    id: str
    project_id: str
    key: str                      # stable template key, e.g. "prd_review"
    title: str
    description: str = ""
    status: TaskStatus = "todo"
    role_required: str
    assignee_member_id: str | None = None
    depends_on: list[str] = Field(default_factory=list)  # task ids
    is_gate: bool = False
    reviews_task_id: str | None = None  # for gate tasks: the task this gate reviews
    acceptance_criteria: str | None = None
    artifact: str | None = None
    # B4: the full submit history (oldest first). ``artifact`` stays the latest
    # version's content; this list is appended on each submit and never rewritten.
    artifact_versions: list[ArtifactVersion] = Field(default_factory=list)
    review_comment: str | None = None
    blocker: str | None = None
    # B2: the background Agent run that produced (or is producing) this task's
    # deliverable. Set when an Agent worker runs the task; links the task to its
    # frame trace (GET /api/crew/runs/{run_ref}/frames). None for human-done tasks.
    run_ref: str | None = None
    # C1 在飞信号:the ISO instant an Agent worker started running this task. The
    # worker stamps it right after the start transition and CLEARS it (None) when
    # the run reaches a terminal outcome (submitted OR blocked). The FE推进 elapsed
    # from it (无值显「刚刚开始」); the transient ``run_inflight`` boolean is a
    # route-layer snapshot annotation (not persisted here — see routes/crew.py).
    run_started_at: str | None = None
    # Provenance: "sop" for template-instantiated tasks, "channel" for tasks grown
    # from a channel「+任务」command (B3). created_from_message_id links the latter
    # back to the originating ChannelMessage.
    origin: str = "sop"
    created_from_message_id: str | None = None


class TaskDraft(BaseModel):
    """A model-drafted (or deterministically-fallen-back) candidate task from a
    channel「+任务」command (B3), pending Boss confirmation.

    ``depends_on`` references OTHER drafts *by their title* (not ids — the tasks
    do not exist yet); ``confirm_drafts`` resolves them against the confirmed
    subset (and existing project task titles) when materializing real tasks.
    """
    title: str
    role: str
    depends_on: list[str] = Field(default_factory=list)  # references by draft title
    acceptance: str = ""


class SopTaskSpec(BaseModel):
    key: str
    title: str
    role_required: str
    depends_on: list[str] = Field(default_factory=list)  # template keys
    is_gate: bool = False
    reviews: str | None = None    # template key this gate reviews
    acceptance_criteria: str | None = None


class SopTemplate(BaseModel):
    id: str
    name: str
    description: str = ""
    tasks: list[SopTaskSpec]


class CrewProject(BaseModel):
    id: str
    workspace_id: str
    owner_user_id: str
    goal_text: str
    sop_template_id: str
    status: Literal["active", "completed"] = "active"
    # Provenance for projects that are not user-created from scratch. Normal
    # projects keep "user"; built-in showcases carry structured metadata below.
    source: str = "user"
    showcase: dict[str, Any] | None = None
    tasks: list[CrewTask] = Field(default_factory=list)
    audit_events: list[dict[str, Any]] = Field(default_factory=list)
    # Store row schema/version. Hidden from JSON payloads and API responses, but
    # carried on loaded models so save_project can reject stale snapshots.
    project_version: int = Field(default=0, exclude=True)


ChannelAuthorKind = Literal["anna", "member", "worker"]
ChannelMessageKind = Literal["event", "artifact", "review", "say", "command"]
NotificationKind = Literal[
    "assigned", "mention", "review_due", "rejected", "blocked", "approval",
    "unlocked", "grown",
]


class ChannelMessage(BaseModel):
    """A single row in a project's channel chronicle.

    Event/artifact/review rows are derived from a lifecycle transition (single
    source of truth: they share the transition's fact and carry ``audit_ref``
    pointing at the corresponding ``_append_event`` entry). ``say`` rows are
    user-authored and have no audit correspondence (``audit_ref`` is empty).
    """
    id: str
    project_id: str
    workspace_id: str
    seq: int                          # per-project, 1-based, ascending
    author_kind: ChannelAuthorKind = "anna"
    author_member_id: str | None = None
    # Worker Profile rows are emitted by Anna's Harness on behalf of a named
    # profile. They are not human members and do not create another Anna Agent.
    worker_profile_ref: str | None = None
    caused_by_execution_id: str | None = None
    kind: ChannelMessageKind
    body: str
    task_id: str | None = None
    run_ref: str | None = None
    mentions: list[str] = Field(default_factory=list)  # member ids
    audit_ref: str = ""               # e.g. "#a3"; empty for non-audited rows
    # Structured extra for ``kind="command"`` draft rows (B3): the drafted tasks
    # + the source message id they were grown from. None for every other kind.
    payload: dict[str, Any] | None = None
    created_at: str

    @model_validator(mode="after")
    def validate_worker_provenance(self) -> Self:
        """Keep Worker Profile output explicit and execution-auditable."""
        provenance = {
            "worker_profile_ref": self.worker_profile_ref,
            "caused_by_execution_id": self.caused_by_execution_id,
        }
        if self.author_kind == "worker":
            missing = [
                field_name
                for field_name, value in provenance.items()
                if value is None or not value.strip()
            ]
            if missing:
                raise ValueError(
                    "worker channel messages require non-empty " + ", ".join(missing)
                )
        elif any(value is not None for value in provenance.values()):
            raise ValueError(
                "only worker channel messages may carry worker_profile_ref or "
                "caused_by_execution_id"
            )
        return self


class Notification(BaseModel):
    """A per-member notification, deduplicated by ``idempotency_key``."""
    id: str
    workspace_id: str
    to_member_id: str
    kind: NotificationKind
    title: str
    deep_link: str
    project_id: str | None = None
    task_id: str | None = None
    read_at: str | None = None
    idempotency_key: str
    created_at: str
