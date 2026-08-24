from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.api.app import main as api_main
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore
from services.runtime.app.execution.kernel import AgentExecutionKernel
from services.runtime.app.execution.models import LoopResult
from services.runtime.app.execution.runtime import AgentExecutionRuntime
from services.runtime.app.execution.store import SQLiteExecutionStore


class _ClosedTrackingStore(SQLiteExecutionStore):
    def __init__(self, db_path):
        super().__init__(db_path)
        self.closed = False

    def close(self) -> None:
        self.closed = True
        super().close()


class _SuccessAdapter:
    async def run(self, snapshot, signals) -> LoopResult:
        return LoopResult(status="succeeded")


def _identity(tmp_path) -> IdentityService:
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(store)
    return IdentityService(store)


def _crew(tmp_path) -> CrewService:
    return CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))


def test_create_app_rejects_split_execution_components(tmp_path):
    store_a = SQLiteExecutionStore(tmp_path / "a.sqlite3")
    store_b = SQLiteExecutionStore(tmp_path / "b.sqlite3")
    with pytest.raises(ValueError, match="share one store"):
        api_main.create_app(
            identity_service=_identity(tmp_path),
            crew_service=_crew(tmp_path),
            execution_store=store_a,
            execution_kernel=AgentExecutionKernel(store_b),
        )
    runtime_b = AgentExecutionRuntime(
        store=store_b,
        adapter=_SuccessAdapter(),
        worker_count=1,
        idle_poll_seconds=0.01,
    )
    with pytest.raises(ValueError, match="share one store"):
        api_main.create_app(
            identity_service=_identity(tmp_path),
            crew_service=_crew(tmp_path),
            execution_store=store_a,
            execution_runtime=runtime_b,
        )
    kernel_a = AgentExecutionKernel(store_a)
    with pytest.raises(ValueError, match="share one store"):
        api_main.create_app(
            identity_service=_identity(tmp_path),
            crew_service=_crew(tmp_path),
            execution_kernel=kernel_a,
            execution_runtime=runtime_b,
        )
    store_a.close()
    store_b.close()


def test_create_app_uses_injected_store_for_kernel_runtime_and_does_not_close_it(tmp_path):
    store = _ClosedTrackingStore(tmp_path / "executions.sqlite3")
    app = api_main.create_app(
        identity_service=_identity(tmp_path),
        crew_service=_crew(tmp_path),
        execution_store=store,
    )
    assert app.state.execution_store is store
    assert getattr(app.state.execution_kernel, "_store") is store
    assert getattr(app.state.execution_runtime, "_store") is store

    with TestClient(app):
        pass

    assert not store.closed
    assert store.claim_next(owner_id="probe") is None
    store.close()


def test_create_app_uses_injected_kernel_store_and_does_not_close_it(tmp_path):
    store = _ClosedTrackingStore(tmp_path / "executions.sqlite3")
    app = api_main.create_app(
        identity_service=_identity(tmp_path),
        crew_service=_crew(tmp_path),
        execution_kernel=AgentExecutionKernel(store),
    )
    assert app.state.execution_store is store
    assert getattr(app.state.execution_kernel, "_store") is store
    assert getattr(app.state.execution_runtime, "_store") is store

    with TestClient(app):
        pass

    assert not store.closed
    assert store.claim_next(owner_id="probe") is None
    store.close()


def test_create_app_uses_injected_runtime_store_and_does_not_close_it(tmp_path):
    store = _ClosedTrackingStore(tmp_path / "executions.sqlite3")
    runtime = AgentExecutionRuntime(
        store=store,
        adapter=_SuccessAdapter(),
        worker_count=1,
        idle_poll_seconds=0.01,
    )
    app = api_main.create_app(
        identity_service=_identity(tmp_path),
        crew_service=_crew(tmp_path),
        execution_runtime=runtime,
    )
    assert app.state.execution_store is store
    assert getattr(app.state.execution_kernel, "_store") is store
    assert app.state.execution_runtime is runtime

    with TestClient(app):
        pass

    assert not store.closed
    store.close()


def test_create_app_accepts_fully_injected_components_and_does_not_close_store(tmp_path):
    store = _ClosedTrackingStore(tmp_path / "executions.sqlite3")
    kernel = AgentExecutionKernel(store)
    runtime = AgentExecutionRuntime(
        store=store,
        adapter=_SuccessAdapter(),
        worker_count=1,
        idle_poll_seconds=0.01,
    )
    app = api_main.create_app(
        identity_service=_identity(tmp_path),
        crew_service=_crew(tmp_path),
        execution_store=store,
        execution_kernel=kernel,
        execution_runtime=runtime,
    )
    assert app.state.execution_store is store
    assert app.state.execution_kernel is kernel
    assert app.state.execution_runtime is runtime

    with TestClient(app):
        pass

    assert not store.closed
    assert store.claim_next(owner_id="probe") is None
    store.close()


def test_create_app_closes_default_execution_store(tmp_path, monkeypatch):
    store = _ClosedTrackingStore(tmp_path / "executions.sqlite3")
    monkeypatch.setattr(api_main, "_default_execution_store", lambda: store)

    app = api_main.create_app(
        identity_service=_identity(tmp_path),
        crew_service=_crew(tmp_path),
    )

    with TestClient(app):
        pass

    assert store.closed
