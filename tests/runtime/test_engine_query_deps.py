"""Tests for engine/query_deps.py — DI container (T4).

Covers:
1. production_deps() wires the real stream_model function.
2. QueryDeps instances are frozen (FrozenInstanceError on assignment).
3. Injection works: a fake stream_model callable can be injected, stored,
   and driven through deps.stream_model(...) to confirm the DI contract.
"""
from __future__ import annotations

import asyncio
import dataclasses

import pytest

from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps, production_deps
from services.runtime.app.engine.streaming_model import stream_model


# ---------------------------------------------------------------------------
# 1. Production wiring
# ---------------------------------------------------------------------------


def test_production_deps_wires_real_stream_model() -> None:
    deps = production_deps()
    assert deps.stream_model is stream_model


# ---------------------------------------------------------------------------
# 2. Frozen
# ---------------------------------------------------------------------------


def test_query_deps_is_frozen() -> None:
    async def fake(*args, **kwargs):
        yield ModelChunk(kind="final")

    deps = QueryDeps(stream_model=fake)
    with pytest.raises(dataclasses.FrozenInstanceError):
        deps.stream_model = fake  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 3. Injection drive-through
# ---------------------------------------------------------------------------


async def fake_stream_model(*args, **kwargs):
    yield ModelChunk(kind="text_delta", text="hi")
    yield ModelChunk(kind="final")


def test_injection_stores_and_drives_fake() -> None:
    deps = QueryDeps(stream_model=fake_stream_model)

    # The injected callable is exactly what was passed in.
    assert deps.stream_model is fake_stream_model

    # Drive it through deps.stream_model to prove QueryDeps just holds and
    # exposes the callable — this is the DI contract T5 relies on.
    async def _collect():
        chunks = []
        async for chunk in deps.stream_model("run-1", [], object()):
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(_collect())
    assert len(chunks) == 2
    assert chunks[0] == ModelChunk(kind="text_delta", text="hi")
    assert chunks[1] == ModelChunk(kind="final")
