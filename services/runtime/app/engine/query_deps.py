"""Dependency-injection container for the streaming engine (T4).

``QueryDeps`` holds the injectable I/O dependencies the agent loop (T5)
needs at call time.  Passing a ``deps`` override lets tests inject a fake
``stream_model`` directly instead of monkeypatching; the scope is
intentionally narrow (one dep) because compaction and audit governance live
inside ``stream_model`` itself — there is nothing else the loop needs to
swap out in tests.

``production_deps()`` wires the real streaming model for production use.
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.streaming_model import stream_model


@dataclass(frozen=True)
class QueryDeps:
    """Injectable I/O dependencies for the engine loop.

    Passing a ``deps`` override lets tests inject a fake ``stream_model``
    directly instead of monkeypatching; scope is intentionally one dep
    because compaction/audit live inside ``stream_model``.
    """

    stream_model: Callable[..., AsyncIterator[ModelChunk]]


def production_deps() -> QueryDeps:
    """Return ``QueryDeps`` wired to the real streaming model."""
    return QueryDeps(stream_model=stream_model)
