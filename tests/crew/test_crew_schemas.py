from __future__ import annotations

import pytest
from pydantic import ValidationError

from services.crew.app.schemas import ChannelMessage


def _message_data(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "id": "proj_1:m1",
        "project_id": "proj_1",
        "workspace_id": "ws1",
        "seq": 1,
        "author_kind": "anna",
        "kind": "event",
        "body": "updated",
        "created_at": "2026-08-16T00:00:00+00:00",
    }
    data.update(overrides)
    return data


def test_worker_channel_message_requires_complete_non_empty_provenance():
    message = ChannelMessage.model_validate(
        _message_data(
            author_kind="worker",
            worker_profile_ref="member:agent_scribe",
            caused_by_execution_id="exec_123",
        )
    )

    assert message.worker_profile_ref == "member:agent_scribe"
    assert message.caused_by_execution_id == "exec_123"


@pytest.mark.parametrize(
    ("worker_profile_ref", "caused_by_execution_id", "missing_field"),
    [
        (None, "exec_123", "worker_profile_ref"),
        ("   ", "exec_123", "worker_profile_ref"),
        ("member:agent_scribe", None, "caused_by_execution_id"),
        ("member:agent_scribe", "", "caused_by_execution_id"),
    ],
)
def test_worker_channel_message_rejects_missing_or_blank_provenance(
    worker_profile_ref: str | None,
    caused_by_execution_id: str | None,
    missing_field: str,
):
    with pytest.raises(ValidationError, match=missing_field):
        ChannelMessage.model_validate(
            _message_data(
                author_kind="worker",
                worker_profile_ref=worker_profile_ref,
                caused_by_execution_id=caused_by_execution_id,
            )
        )


@pytest.mark.parametrize("author_kind", ["anna", "member"])
@pytest.mark.parametrize(
    "provenance",
    [
        {"worker_profile_ref": "member:agent_scribe"},
        {"caused_by_execution_id": "exec_123"},
        {
            "worker_profile_ref": "member:agent_scribe",
            "caused_by_execution_id": "exec_123",
        },
    ],
)
def test_non_worker_channel_message_rejects_worker_provenance(
    author_kind: str,
    provenance: dict[str, str],
):
    with pytest.raises(
        ValidationError,
        match="only worker channel messages may carry",
    ):
        ChannelMessage.model_validate(
            _message_data(author_kind=author_kind, **provenance)
        )
