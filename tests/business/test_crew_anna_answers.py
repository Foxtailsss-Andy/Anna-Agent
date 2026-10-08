"""@Anna is always answered in product mode, in the background (ticket P · AC3).

Seam: ``POST /api/crew/projects/{id}/channel`` on the Crew router in product
mode. The Node Host is faked at the ``harness_client`` boundary; its
``submit_and_wait`` is gated so a blocking POST would be observable.
"""
from __future__ import annotations

import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.routes.crew import build_router as build_crew_router
from services.business.harness_client import HarnessHostError, HarnessRun
from services.crew.app.command_drafting import CommandDraftingService
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore
from services.runtime.app.config import RuntimeSettings

_GATE_SECONDS = 2.0


class _GatedHost:
    """Fake Host: each ``submit_and_wait`` waits for ``release`` (bounded)."""

    def __init__(self, outcome):
        self.release = threading.Event()
        self.submitted = []
        self._outcome = outcome

    def submit_and_wait(self, task):
        self.submitted.append(task)
        self.release.wait(_GATE_SECONDS)
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome(task)


def _app(tmp_path, host):
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    app = FastAPI()
    app.include_router(
        build_crew_router(
            crew,
            identity,
            decomposition=object(),
            matching=object(),
            # Unconfigured, network-free drafter → deterministic fallback.
            command_drafting=CommandDraftingService(settings=RuntimeSettings()),
            harness_client=host,
            product_mode=True,
        )
    )
    token = identity.login("boss@anna.demo", "crew-demo").token
    return TestClient(app), {"Authorization": f"Bearer {token}"}


def _project(client, auth) -> str:
    return client.post(
        "/api/crew/projects",
        headers=auth,
        json={"goal_text": "营销物料", "sop_template_id": "marketing_collateral"},
    ).json()["id"]


def _wait_for(client, auth, pid, predicate, seconds=3.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        rows = client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()["messages"]
        found = [row for row in rows if predicate(row)]
        if found:
            return found
        time.sleep(0.02)
    return []


def _anna_outcomes(client, auth, pid):
    """Anna answers (say) and Anna failure rows on the channel."""
    rows = client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()["messages"]
    return [
        row for row in rows
        if row["author_kind"] == "anna"
        and (row["kind"] == "say" or (row.get("payload") or {}).get("anna_failure"))
    ]


def test_at_anna_without_task_intent_is_answered_in_background(tmp_path):
    host = _GatedHost(
        lambda task: HarnessRun(
            run_id=task.run_id,
            status="completed",
            result={"assistant_message": "Andy 目前没有进行中的任务。"},
        )
    )
    client, auth = _app(tmp_path, host)
    pid = _project(client, auth)

    started = time.monotonic()
    response = client.post(
        f"/api/crew/projects/{pid}/channel",
        headers=auth,
        # A remark that is neither a question nor a task request (the review's
        # "新增…指派给 Andy" sentence now drafts a card, see test_channel_command).
        json={"body": "@Anna Andy 这周会比较忙", "mentions": ["anna"]},
    )
    elapsed = time.monotonic() - started

    # The POST returned the stored say while the Host answer is still gated.
    assert response.status_code == 200
    assert elapsed < _GATE_SECONDS / 2
    say = response.json()
    assert say["kind"] == "say" and say["author_kind"] == "member"
    assert _anna_outcomes(client, auth, pid) == []

    host.release.set()
    answers = _wait_for(
        client, auth, pid, lambda row: row["author_kind"] == "anna" and row["kind"] == "say"
    )
    assert [row["body"] for row in answers] == ["Andy 目前没有进行中的任务。"]
    assert answers[0]["run_ref"] == f"crew-context:{pid}:{say['id']}"
    task = host.submitted[0]
    assert task.run_id == f"crew-context:{pid}:{say['id']}"
    assert task.permission_mode == "readonly"
    assert task.actor_user_id == "acc_boss"
    assert task.context["source"] == "crew.contextual_answer"
    assert task.context["source_message_id"] == say["id"]
    assert task.context["project"]["id"] == pid
    assert any(row["id"] == say["id"] for row in task.context["channel_messages"])


@pytest.mark.parametrize(
    ("outcome", "expected_body"),
    [
        (
            HarnessHostError("Harness Host task did not finish", code="harness_wait_timeout"),
            "Anna 暂时无法回答：harness_wait_timeout",
        ),
        (
            lambda task: HarnessRun(
                run_id=task.run_id, status="failed", result={"error_code": "provider_unavailable"}
            ),
            "Anna 暂时无法回答：provider_unavailable",
        ),
    ],
    ids=["host_error", "failed_run"],
)
def test_host_answer_failure_leaves_one_visible_anna_row(tmp_path, outcome, expected_body):
    host = _GatedHost(outcome)
    host.release.set()
    client, auth = _app(tmp_path, host)
    pid = _project(client, auth)

    response = client.post(
        f"/api/crew/projects/{pid}/channel",
        headers=auth,
        json={"body": "@Anna 现在进展如何？", "mentions": ["anna"]},
    )
    assert response.status_code == 200

    failures = _wait_for(client, auth, pid, lambda row: row["body"] == expected_body)
    assert len(failures) == 1
    assert failures[0]["author_kind"] == "anna" and failures[0]["kind"] == "event"
    time.sleep(0.1)
    assert len(_anna_outcomes(client, auth, pid)) == 1


def test_at_anna_with_task_intent_gets_a_card_not_a_host_answer(tmp_path):
    host = _GatedHost(AssertionError("contextual answer must not run for task intent"))
    host.release.set()
    client, auth = _app(tmp_path, host)
    pid = _project(client, auth)

    say = client.post(
        f"/api/crew/projects/{pid}/channel",
        headers=auth,
        json={"body": "@Anna 帮我加个任务：竞品调研", "mentions": ["anna"]},
    ).json()

    cards = _wait_for(
        client,
        auth,
        pid,
        lambda row: row["kind"] == "command"
        and (row.get("payload") or {}).get("origin_message_id") == say["id"],
    )
    assert len(cards) == 1
    assert host.submitted == []
