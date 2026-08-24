"""Tests for services.runtime.app.engine.query_config.

Covers: construction, field defaults, and frozen-instance enforcement.
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from services.runtime.app.engine.query_config import QueryConfig


def test_query_config_holds_field_values():
    cfg = QueryConfig(
        run_id="run-1",
        skill_id="skill-abc",
        tools=[{"name": "search"}],
    )
    assert cfg.run_id == "run-1"
    assert cfg.skill_id == "skill-abc"
    assert cfg.tools == [{"name": "search"}]


def test_query_config_max_turns_defaults_to_8():
    cfg = QueryConfig(run_id="r", skill_id="s", tools=[])
    assert cfg.max_turns == 8


def test_query_config_error_message_default():
    cfg = QueryConfig(run_id="r", skill_id="s", tools=[])
    assert cfg.config_error_message == (
        "model endpoint and API key are required before running Anna agent"
    )


def test_query_config_accepts_explicit_max_turns():
    cfg = QueryConfig(run_id="r", skill_id="s", tools=[], max_turns=20)
    assert cfg.max_turns == 20


def test_query_config_is_frozen():
    cfg = QueryConfig(run_id="r", skill_id="s", tools=[])
    with pytest.raises(FrozenInstanceError):
        cfg.max_turns = 1  # type: ignore[misc]
