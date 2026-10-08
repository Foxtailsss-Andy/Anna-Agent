"""@Anna coordination card repairs (ticket P · F1 / visible failure).

Seam: ``CrewService.draft_intent_card`` with the product-mode drafter
(``CommandDraftingService`` over ``HostHarnessRuntime``), the Host itself faked
at the HTTP boundary with ``httpx.MockTransport``.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx

from services.business.harness_client import HarnessHostClient
from services.business.host_runtime import HostHarnessRuntime
from services.business.mode import BusinessModeConfig
from services.crew.app.actors import SYSTEM_ANNA_ACTOR_ID
from services.crew.app.command_drafting import CommandDraftingService
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore

_KIND = {"acc_boss": "human", "acc_andy": "human", "acc_agent_scribe": "agent"}


def _host_drafter(submitted: list[dict]) -> CommandDraftingService:
    """Product-mode drafter whose Host emits one ``crew.emit_task_drafts`` call."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            body = json.loads(request.content)
            submitted.append(body)
            return httpx.Response(202, json={"run_id": body["run_id"], "status": "queued"})
        run_id = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(
            200,
            json={
                "run_id": run_id,
                "status": "completed",
                "result": {
                    "tool_calls": [
                        {
                            "id": "draft-1",
                            "name": "crew__emit_task_drafts",
                            "arguments": {
                                "drafts": [
                                    {"title": "竞品调研", "role": "设计", "acceptance": "三家竞品对比"}
                                ]
                            },
                        }
                    ]
                },
            },
        )

    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    client = HarnessHostClient(config, transport=httpx.MockTransport(handler))
    return CommandDraftingService(harness_runtime=HostHarnessRuntime(client))


def _svc(tmp_path: Path, drafter) -> CrewService:
    return CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        drafter=drafter,
        member_kind=lambda mid: _KIND.get(mid),
    )


def test_intent_card_through_host_drafter_is_scoped_to_the_say_author(tmp_path):
    submitted: list[dict] = []
    svc = _svc(tmp_path, _host_drafter(submitted))
    project = svc.create_project("ws_crew_demo", "acc_boss", "营销物料", "marketing_collateral")
    say = svc.say(
        project.id,
        "acc_andy",
        "@Anna 请新增一个竞品调研任务",
        mentions=[SYSTEM_ANNA_ACTOR_ID],
    )

    card = svc.draft_intent_card(project.id, say)

    assert card is not None
    assert card.kind == "command" and card.author_kind == "anna"
    assert card.payload["origin"] == "anna_coordination"
    assert [d["title"] for d in card.payload["drafts"]] == ["竞品调研"]
    # The Host planning task runs in the say author's authenticated scope.
    assert len(submitted) == 1
    assert submitted[0]["actor_user_id"] == "acc_andy"
    assert submitted[0]["workspace_id"] == "ws_crew_demo"


class _ExplodingDrafter:
    harness_runtime = None

    def draft(self, **_kwargs):
        raise RuntimeError("secret upstream detail")


def test_intent_drafting_failure_leaves_one_visible_anna_row_per_say(tmp_path, caplog):
    svc = _svc(tmp_path, _ExplodingDrafter())
    project = svc.create_project("ws_crew_demo", "acc_boss", "营销物料", "marketing_collateral")
    say = svc.say(
        project.id, "acc_boss", "@Anna 帮我加个任务：竞品调研", mentions=[SYSTEM_ANNA_ACTOR_ID]
    )

    with caplog.at_level(logging.WARNING):
        first = svc.draft_intent_card(project.id, say)
        second = svc.draft_intent_card(project.id, say)

    assert first is not None
    assert first.kind == "event" and first.author_kind == "anna"
    assert first.body == "Anna 未能整理协调提案：intent_drafting_failed"
    assert second is None  # one outcome per say: no retry, no duplicate row
    failures = [
        m for m in svc.list_channel(project.id)
        if m.body.startswith("Anna 未能整理协调提案")
    ]
    assert len(failures) == 1
    assert "secret upstream detail" not in failures[0].body
    assert any("intent drafting failed" in r.getMessage() for r in caplog.records)
    # Still draft state only: no task was created by the failed attempt.
    assert len(svc.get_project(project.id).tasks) == len(project.tasks)
