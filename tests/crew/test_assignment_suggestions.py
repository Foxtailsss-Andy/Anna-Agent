from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

from services.crew.app.assignment_suggestions import (
    AssignmentSuggestionService,
    SuggestionStoreFull,
)
from services.crew.app.service import CrewService
from services.crew.app.service import SuggestionAdoptionError
from services.crew.app.store import SQLiteCrewStore
from services.crew.app.schemas import CrewProject, CrewTask
from services.identity.app.schemas import Account


class _Identity:
    def __init__(self, members: list[Account]) -> None:
        self._members = members

    def list_members(self, workspace_id: str) -> list[Account]:
        return [member for member in self._members if member.workspace_id == workspace_id]


class _Host:
    async def decide_assignee_async(self, request):  # pragma: no cover - must not run here
        raise AssertionError("role rule must not call Host")


@dataclass
class _CountingHost:
    calls: int = 0
    requests: list = None

    async def decide_assignee_async(self, request):
        self.calls += 1
        if self.requests is None:
            self.requests = []
        self.requests.append(request)
        return type(
            "Result",
            (),
            {
                "status": "suggested",
                "member_id": request.state.candidates[0].id,
                "decision_id": request.decision_id,
                "reason_code": "model_choice",
                "source": "jev",
                "meta": type("Meta", (), {"model_dump": lambda self, **_: {"provider_calls": 1}})(),
            },
        )()


class _BlockingHost:
    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def decide_assignee_async(self, request):
        self.started.set()
        await asyncio.Event().wait()


def _project() -> tuple[CrewProject, CrewTask]:
    task = CrewTask(
        id="task_1",
        project_id="project_1",
        key="draft",
        title="写方案",
        description="",
        role_required="writer",
        acceptance_criteria=None,
    )
    return (
        CrewProject(
            id="project_1",
            workspace_id="workspace_1",
            owner_user_id="owner_1",
            goal_text="交付预览",
            sop_template_id="template_1",
            tasks=[task],
        ),
        task,
    )


def test_unique_exact_role_match_is_rule_suggestion_without_host_call():
    project, task = _project()
    identity = _Identity(
        [
            Account(
                id="member_1",
                workspace_id="workspace_1",
                email="hidden@example.test",
                display_name="不应发送",
                role="writer",
                kind="human",
            )
        ]
    )
    service = AssignmentSuggestionService(identity=identity, host_client=_Host())

    result = asyncio.run(
        service.suggest(
            workspace_id="workspace_1",
            actor_user_id="owner_1",
            project=project,
            task=task,
            decision_id="550e8400-e29b-41d4-a716-446655440000",
        )
    )

    assert result.status == "suggested"
    assert result.source == "role_rule"
    assert result.member_id == "member_1"
    assert result.reason_code == "exact_role_match"
    assert result.meta is None


def test_non_unique_candidates_share_one_host_request_and_keep_server_facts():
    project, task = _project()
    host = _CountingHost()
    identity = _Identity(
        [
            Account(id="member_b", workspace_id="workspace_1", email="b", display_name="B", role="writer", kind="human"),
            Account(id="member_a", workspace_id="workspace_1", email="a", display_name="A", role="writer", kind="agent"),
        ]
    )
    service = AssignmentSuggestionService(identity=identity, host_client=host)

    async def call_twice():
        first, second = await asyncio.gather(
            service.suggest(
                workspace_id="workspace_1", actor_user_id="owner_1", project=project,
                task=task, decision_id="550e8400-e29b-41d4-a716-446655440000",
            ),
            service.suggest(
                workspace_id="workspace_1", actor_user_id="owner_1", project=project,
                task=task, decision_id="550e8400-e29b-41d4-a716-446655440000",
            ),
        )
        return first, second

    first, second = asyncio.run(call_twice())

    assert host.calls == 1
    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert first.member_id == "member_a"
    payload = host.requests[0].model_dump(mode="json")
    assert "display_name" not in str(payload)
    assert "@example" not in str(payload)


def test_cancel_pending_suggestion_prevents_late_result():
    project, task = _project()
    host = _BlockingHost()
    identity = _Identity(
        [
            Account(id="member_a", workspace_id="workspace_1", email="a", display_name="A", role="writer", kind="agent"),
            Account(id="member_b", workspace_id="workspace_1", email="b", display_name="B", role="writer", kind="human"),
        ]
    )
    service = AssignmentSuggestionService(identity=identity, host_client=host)
    decision_id = "550e8400-e29b-41d4-a716-446655440000"

    async def exercise():
        pending = asyncio.create_task(
            service.suggest(
                workspace_id="workspace_1", actor_user_id="owner_1", project=project,
                task=task, decision_id=decision_id,
            )
        )
        await host.started.wait()
        assert await service.cancel(
            workspace_id="workspace_1", actor_user_id="owner_1",
            project_id=project.id, task_id=task.id, decision_id=decision_id,
        ) == "canceled"
        return await pending

    result = asyncio.run(exercise())

    assert result.status == "unavailable"
    assert result.reason_code == "canceled"
    assert result.member_id is None


def test_pending_cancel_is_loop_thread_safe_under_asyncio_debug():
    project, task = _project()
    host = _BlockingHost()
    identity = _Identity([
        Account(id="member_a", workspace_id="workspace_1", email="a", display_name="A", role="writer", kind="agent"),
        Account(id="member_b", workspace_id="workspace_1", email="b", display_name="B", role="writer", kind="human"),
    ])
    service = AssignmentSuggestionService(identity=identity, host_client=host)
    decision_id = "850e8400-e29b-41d4-a716-446655440000"

    async def exercise():
        pending = asyncio.create_task(service.suggest(
            workspace_id="workspace_1", actor_user_id="owner_1", project=project,
            task=task, decision_id=decision_id,
        ))
        await host.started.wait()
        assert await service.cancel(
            workspace_id="workspace_1", actor_user_id="owner_1", project_id=project.id,
            task_id=task.id, decision_id=decision_id,
        ) == "canceled"
        return await pending

    result = asyncio.run(exercise(), debug=True)
    assert result.reason_code == "canceled"


def test_empty_and_oversized_roster_abstain_before_host():
    project, task = _project()
    empty_host = _CountingHost()
    empty_service = AssignmentSuggestionService(identity=_Identity([]), host_client=empty_host)
    empty = asyncio.run(
        empty_service.suggest(
            workspace_id="workspace_1", actor_user_id="owner_1", project=project,
            task=task, decision_id="550e8400-e29b-41d4-a716-446655440000",
        )
    )
    oversized_members = [
        Account(
            id=f"member_{index}", workspace_id="workspace_1", email=f"m{index}",
            display_name=f"M{index}", role="other", kind="human",
        )
        for index in range(21)
    ]
    oversized_host = _CountingHost()
    oversized_service = AssignmentSuggestionService(
        identity=_Identity(oversized_members), host_client=oversized_host
    )
    oversized = asyncio.run(
        oversized_service.suggest(
            workspace_id="workspace_1", actor_user_id="owner_1", project=project,
            task=task, decision_id="650e8400-e29b-41d4-a716-446655440000",
        )
    )

    assert (empty.status, empty.reason_code, empty_host.calls) == (
        "abstained", "no_candidates", 0
    )
    assert (oversized.status, oversized.reason_code, oversized_host.calls) == (
        "unavailable", "candidate_limit_exceeded", 0
    )


def test_scope_isolation_and_active_record_cap():
    project, task = _project()
    host = _CountingHost()
    identity = _Identity(
        [
            Account(id="member_a", workspace_id="workspace_1", email="a", display_name="A", role="writer", kind="agent"),
            Account(id="member_b", workspace_id="workspace_1", email="b", display_name="B", role="writer", kind="human"),
        ]
    )
    service = AssignmentSuggestionService(identity=identity, host_client=host)

    async def exercise():
        await service.suggest(
            workspace_id="workspace_1", actor_user_id="actor_1", project=project,
            task=task, decision_id="550e8400-e29b-41d4-a716-446655440000",
        )
        await service.suggest(
            workspace_id="workspace_1", actor_user_id="actor_2", project=project,
            task=task, decision_id="550e8400-e29b-41d4-a716-446655440000",
        )
        for index in range(126):
            await service.suggest(
                workspace_id="workspace_1", actor_user_id="actor_1", project=project,
                task=task, decision_id=f"{index:08d}-e29b-41d4-a716-446655440000",
            )
        try:
            await service.suggest(
                workspace_id="workspace_1", actor_user_id="actor_1", project=project,
                task=task, decision_id="99999999-e29b-41d4-a716-446655440000",
            )
        except SuggestionStoreFull:
            return
        raise AssertionError("expected active record cap")

    asyncio.run(exercise())
    assert host.calls == 128


def test_state_limit_is_checked_before_rule_shortcut():
    project, task = _project()
    task.description = "资料" * 10_000
    host = _CountingHost()
    service = AssignmentSuggestionService(
        identity=_Identity([
            Account(id="member_1", workspace_id="workspace_1", email="a", display_name="A", role="writer", kind="human")
        ]),
        host_client=host,
    )

    result = asyncio.run(
        service.suggest(
            workspace_id="workspace_1", actor_user_id="owner_1", project=project,
            task=task, decision_id="550e8400-e29b-41d4-a716-446655440000",
        )
    )

    assert (result.status, result.reason_code, host.calls) == (
        "unavailable", "input_too_large", 0
    )


def test_provider_state_limit_uses_local_candidate_ids():
    project, task = _project()
    task.description = ""
    members = [
        Account(id="member_with_a_long_real_id_" + "x" * 80, workspace_id="workspace_1", email="a", display_name="A", role="writer", kind="human"),
        Account(id="member_with_another_long_real_id_" + "y" * 80, workspace_id="workspace_1", email="b", display_name="B", role="writer", kind="human"),
    ]
    state = {
        "project_goal": project.goal_text,
        "task": {"title": task.title, "description": task.description, "role_required": task.role_required, "acceptance_criteria": task.acceptance_criteria},
        "candidates": [{"id": "c1", "role": "writer", "kind": "human"}, {"id": "c2", "role": "writer", "kind": "human"}],
    }
    base = len(json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    task.description = "z" * (16 * 1024 - base)
    host = _CountingHost()
    service = AssignmentSuggestionService(identity=_Identity(members), host_client=host)
    accepted = asyncio.run(service.suggest(
        workspace_id="workspace_1", actor_user_id="owner_1", project=project,
        task=task, decision_id="950e8400-e29b-41d4-a716-446655440000",
    ))
    task.description += "z"
    rejected = asyncio.run(service.suggest(
        workspace_id="workspace_1", actor_user_id="owner_1", project=project,
        task=task, decision_id="a50e8400-e29b-41d4-a716-446655440000",
    ))

    assert accepted.reason_code != "input_too_large"
    assert rejected.reason_code == "input_too_large"


def test_durable_receipt_wins_over_canceled_collaborator_cache(tmp_path):
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    crew = CrewService(
        store,
        member_facts=lambda _workspace: [{"id": "member_1", "role": "writer", "kind": "human"}],
    )
    project = crew.create_project("workspace_1", "owner_1", "目标", "feature_iteration")
    task = next(item for item in project.tasks if item.key == "brief")
    task.role_required = "writer"
    store.save_project(project)
    identity = _Identity([
        Account(id="member_1", workspace_id="workspace_1", email="m", display_name="M", role="writer", kind="human")
    ])
    first = AssignmentSuggestionService(identity=identity, host_client=_Host())
    second = AssignmentSuggestionService(identity=identity, host_client=_Host())
    decision_id = "b50e8400-e29b-41d4-a716-446655440000"

    async def prepare_first():
        await first.suggest(
            workspace_id="workspace_1", actor_user_id="owner_1", project=project,
            task=task, decision_id=decision_id,
        )
        return await first.cancel(
            workspace_id="workspace_1", actor_user_id="owner_1", project_id=project.id,
            task_id=task.id, decision_id=decision_id,
        )

    assert asyncio.run(prepare_first()) == "canceled"
    context = asyncio.run(_adoption_context(second, project, task, decision_id, "member_1"))
    crew.assign_from_suggestion(
        project.id, task.id, "member_1", decision_id, "owner_1", context,
        workspace_id="workspace_1",
    )
    replay = first.adopt(
        workspace_id="workspace_1", actor_user_id="owner_1", project_id=project.id,
        task_id=task.id, decision_id=decision_id, member_id="member_1",
        receipt_exists=lambda: crew.assignment_receipt_exists(project.id, task.id, "owner_1", decision_id),
        apply=lambda context: crew.commit_from_suggestion(
            project.id, task.id, "member_1", decision_id, "owner_1", context,
            workspace_id="workspace_1",
        ),
    )

    assert replay.first is False


def test_assign_from_suggestion_commits_receipt_and_effects_once(tmp_path):
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    service = CrewService(
        store,
        member_facts=lambda _workspace: [
            {"id": "member_1", "role": "writer", "kind": "human"}
        ],
    )
    project = service.create_project(
        "workspace_1", "owner_1", "目标", "feature_iteration"
    )
    task = next(item for item in project.tasks if item.key == "brief")
    task.role_required = "writer"
    store.save_project(project)
    identity = _Identity([
        Account(id="member_1", workspace_id="workspace_1", email="m", display_name="M", role="writer", kind="human")
    ])
    suggestions = AssignmentSuggestionService(identity=identity, host_client=_Host())
    decision_id = "550e8400-e29b-41d4-a716-446655440000"

    async def make_context():
        return await _adoption_context(suggestions, project, task, decision_id, "member_1")

    context = asyncio.run(make_context())
    assigned = service.assign_from_suggestion(
        project.id, task.id, "member_1", decision_id, "owner_1", context,
        workspace_id="workspace_1",
    )
    replay = service.assign_from_suggestion(
        project.id, task.id, "member_1", decision_id, "owner_1", None,
        workspace_id="workspace_1",
    )

    assigned_task = next(item for item in assigned.tasks if item.id == task.id)
    receipts = [
        event for event in replay.audit_events
        if event.get("type") == "crew.task.assign"
        and event.get("payload", {}).get("decision_id") == decision_id
    ]
    assert assigned_task.assignee_member_id == "member_1"
    assert len(receipts) == 1
    assert len(service.list_channel(project.id)) == 1
    assert len(service.list_notifications("workspace_1", "member_1")) == 1


def test_assign_from_suggestion_rejects_changed_project_fact_without_effects(tmp_path):
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    service = CrewService(
        store,
        member_facts=lambda _workspace: [
            {"id": "member_1", "role": "writer", "kind": "human"}
        ],
    )
    project = service.create_project("workspace_1", "owner_1", "目标", "feature_iteration")
    task = next(item for item in project.tasks if item.key == "brief")
    task.role_required = "writer"
    store.save_project(project)
    identity = _Identity([
        Account(id="member_1", workspace_id="workspace_1", email="m", display_name="M", role="writer", kind="human")
    ])
    suggestions = AssignmentSuggestionService(identity=identity, host_client=_Host())
    decision_id = "650e8400-e29b-41d4-a716-446655440000"
    context = asyncio.run(
        _adoption_context(suggestions, project, task, decision_id, "member_1")
    )
    changed = store.get_project(project.id)
    changed.goal_text = "改动后的目标"
    store.save_project(changed)

    try:
        service.assign_from_suggestion(
            project.id, task.id, "member_1", decision_id, "owner_1", context,
            workspace_id="workspace_1",
        )
    except SuggestionAdoptionError as exc:
        assert exc.code == "suggestion_stale"
    else:
        raise AssertionError("expected stale suggestion")

    current = store.get_project(project.id)
    assert current is not None
    assert next(item for item in current.tasks if item.id == task.id).assignee_member_id is None
    assert service.list_channel(project.id) == []


def test_same_decision_id_in_two_task_scopes_has_two_effects(tmp_path):
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    service = CrewService(
        store,
        member_facts=lambda _workspace: [
            {"id": "member_1", "role": "writer", "kind": "human"}
        ],
    )
    project = service.create_project("workspace_1", "owner_1", "目标", "marketing_collateral")
    tasks = [item for item in project.tasks if item.key in {"brief", "copy"}]
    for task in tasks:
        task.role_required = "writer"
    tasks[1].depends_on = []
    tasks[1].status = "todo"
    store.save_project(project)
    identity = _Identity([
        Account(id="member_1", workspace_id="workspace_1", email="m", display_name="M", role="writer", kind="human")
    ])
    suggestions = AssignmentSuggestionService(identity=identity, host_client=_Host())
    decision_id = "750e8400-e29b-41d4-a716-446655440000"

    async def contexts():
        return [
            await _adoption_context(suggestions, project, task, decision_id, "member_1")
            for task in tasks
        ]

    contexts_for_tasks = asyncio.run(contexts())
    for task, context in zip(tasks, contexts_for_tasks):
        service.assign_from_suggestion(
            project.id, task.id, "member_1", decision_id, "owner_1", context,
            workspace_id="workspace_1",
        )

    messages = service.list_channel(project.id)
    assert len(messages) == 2
    assert len({message.id for message in messages}) == 2
    assert len(service.list_notifications("workspace_1", "member_1")) == 2


async def _adoption_context(suggestions, project, task, decision_id, member_id):
    await suggestions.suggest(
        workspace_id=project.workspace_id, actor_user_id=project.owner_user_id,
        project=project, task=task, decision_id=decision_id,
    )
    captured = {}
    suggestions.adopt(
        workspace_id=project.workspace_id,
        actor_user_id=project.owner_user_id,
        project_id=project.id,
        task_id=task.id,
        decision_id=decision_id,
        member_id=member_id,
        apply=lambda context: captured.setdefault("context", context),
    )
    return captured["context"]
