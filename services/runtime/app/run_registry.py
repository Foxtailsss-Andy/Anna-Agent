from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Generic, TypeVar

T = TypeVar("T")

DEFAULT_MAX_RUNS = 256


class RunRegistry(Generic[T]):
    """Thread-safe run-id allocation + bounded in-memory run storage.

    Replaces the per-orchestrator ``_counter`` / ``dict`` pair, which races under
    Anna's worker-thread streaming (each streamed run executes in its own thread;
    ``self._counter += 1`` is not atomic, so two concurrent runs could collide on
    an id). Ids are allocated under a lock; stored runs are capped (LRU by insert/
    touch order) so a long-lived process does not accumulate every run forever.
    """

    def __init__(self, id_prefix: str, max_runs: int = DEFAULT_MAX_RUNS) -> None:
        if max_runs < 1:
            raise ValueError(f"max_runs must be >= 1, got {max_runs}")
        self._id_prefix = id_prefix
        self._max_runs = max_runs
        self._counter = 0
        self._runs: OrderedDict[str, T] = OrderedDict()
        self._lock = threading.Lock()

    def next_id(self) -> str:
        with self._lock:
            self._counter += 1
            return f"{self._id_prefix}{self._counter:03d}"

    def put(self, run_id: str, run: T) -> None:
        with self._lock:
            self._runs[run_id] = run
            self._runs.move_to_end(run_id)
            while len(self._runs) > self._max_runs:
                self._runs.popitem(last=False)

    def get(self, run_id: str) -> T | None:
        with self._lock:
            return self._runs.get(run_id)

    def values(self) -> list[T]:
        with self._lock:
            return list(self._runs.values())
