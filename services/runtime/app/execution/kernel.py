from __future__ import annotations

from services.runtime.app.execution.models import (
    ExecutionCommand,
    ExecutionEvent,
    ExecutionSnapshot,
)
from services.runtime.app.execution.store import SQLiteExecutionStore


class AgentExecutionKernel:
    """External interface for durable AgentExecution.

    Callers dispatch closed commands, read one snapshot, or read ordered events.
    Worker execution, loop adapters, leases, and storage mechanics stay behind
    the module's internal seams.
    """

    def __init__(self, store: SQLiteExecutionStore, *, max_queue_depth: int = 100) -> None:
        self._store = store
        self._max_queue_depth = max(1, int(max_queue_depth))

    async def dispatch(self, command: ExecutionCommand) -> ExecutionSnapshot:
        return self._store.dispatch(command, max_queue_depth=self._max_queue_depth)

    async def get(self, execution_id: str) -> ExecutionSnapshot:
        return self._store.get(execution_id)

    async def read_events(
        self,
        execution_id: str,
        *,
        after_seq: int = 0,
        limit: int = 200,
    ) -> list[ExecutionEvent]:
        return self._store.read_events(
            execution_id,
            after_seq=after_seq,
            limit=limit,
        )
