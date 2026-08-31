from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.associate.app.state_store import SQLiteAssociateStateStore
from services.chat.app.evaluator import build_judge
from services.chat.app.orchestrator import ChatOrchestrator
from services.create.app.orchestrator import CreateOrchestrator
from services.crew.app.agent_worker import QueryEngineLoopAdapter
from services.crew.app.decomposition import CrewDecompositionService
from services.crew.app.execution_projection import CrewExecutionProjector
from services.crew.app.command_drafting import CommandDraftingService
from services.crew.app.matching import CrewMatchingService
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.hiker.app.orchestrator import HikerOrchestrator
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore
from services.memory.app.store import BusinessMemoryStore
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.reimbursement.app.state_store import SQLiteReimbursementStateStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.execution.kernel import AgentExecutionKernel
from services.runtime.app.execution.runtime import AgentExecutionRuntime
from services.runtime.app.execution.store import SQLiteExecutionStore
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoaderError
from services.runtime.app.validation_ledger import SQLiteRuntimeValidationLedgerStore
from services.business.harness_client import HarnessHostClient
from services.business.host_runtime import HostHarnessRuntime
from services.business.mode import (
    BusinessModeConfig,
    without_model_credentials,
)

from .harness_v2_bridge import HarnessV2Bridge
from .routes import business as business_routes
from .routes import admin_governance as admin_governance_routes
from .routes import admin_runtime as admin_runtime_routes
from .routes import associate as associate_routes
from .routes import auth as auth_routes
from .routes import chat as chat_routes
from .routes import create as create_routes
from .routes import crew as crew_routes
from .routes import hiker as hiker_routes
from .routes import harness_v2 as harness_v2_routes
from .routes import reimbursement as reimbursement_routes
from .routes import session as session_routes
from .routes import workdirs as workdirs_routes
from .runtime_config import _sanitize_reimbursement_probe_draft, local_session_identity


def create_app(
    orchestrator: ReimbursementOrchestrator | None = None,
    hiker_orchestrator: HikerOrchestrator | None = None,
    associate_orchestrator: AssociateReceivablesOrchestrator | None = None,
    create_orchestrator: CreateOrchestrator | None = None,
    chat_orchestrator: ChatOrchestrator | None = None,
    memory_store: BusinessMemoryStore | None = None,
    identity_service: IdentityService | None = None,
    crew_service: CrewService | None = None,
    execution_store: SQLiteExecutionStore | None = None,
    execution_kernel: AgentExecutionKernel | None = None,
    execution_runtime: AgentExecutionRuntime | None = None,
    harness_v2_bridge: HarnessV2Bridge | None = None,
    product_mode: bool | None = None,
    business_mode_config: BusinessModeConfig | None = None,
    harness_client: HarnessHostClient | None = None,
) -> FastAPI:
    mode_config = business_mode_config or BusinessModeConfig.from_env()
    harness_backed = mode_config.enabled if product_mode is None else product_mode
    if harness_backed:
        mode_config.require_enabled()
    settings = without_model_credentials(RuntimeSettings.from_env()) if harness_backed else RuntimeSettings.from_env()
    host = harness_client or (
        HarnessHostClient(mode_config) if harness_backed else None
    )

    reimbursement = orchestrator or _default_reimbursement_orchestrator(settings=settings)
    hiker = hiker_orchestrator or HikerOrchestrator(settings=settings)
    associate = associate_orchestrator or _default_associate_orchestrator(settings=settings)
    # L2 Run 持久化 (P2 状态外置):chat/create 共享一个 SQLite run store。仅在需要
    # 默认构造(未注入编排器)时建库并跑一次「非终态 → interrupted」重启清扫;注入
    # 的编排器自带其 store(或无),这里不覆盖。
    run_store = None
    if chat_orchestrator is None or create_orchestrator is None:
        run_store = _default_run_store(settings=settings)
        if run_store is not None:
            run_store.mark_stale_interrupted("chat")
            run_store.mark_stale_interrupted("create")
    if run_store is None:
        run_store = _default_run_store(settings=settings)
    create = create_orchestrator or CreateOrchestrator(run_store=run_store, settings=settings)
    memory = memory_store or _default_memory_store(settings=settings)
    # J2 判断力轮:生产装配独立法官(build_judge)开启判断层;测试直接构造编排器时
    # 不装配 judge → 判断层惰性(零评估、字节等价)。settings 显式共享,判官与主循环
    # 同一模型配置。
    chat_settings = settings
    chat = chat_orchestrator or ChatOrchestrator(
        settings=chat_settings,
        memory_store=memory,
        run_store=run_store,
        evaluator_judge=build_judge(chat_settings),
    )
    if harness_backed:
        # Injected test/custom orchestrators must obey the same boundary as
        # defaults: their model settings are stripped before the app is exposed.
        for component in (reimbursement, hiker, associate, create, chat):
            component_settings = getattr(component, "settings", None)
            if component_settings is None:
                continue
            safe = without_model_credentials(component_settings)
            component.settings = safe
            provider = getattr(component, "model_provider", None)
            if provider is not None and hasattr(provider, "settings"):
                provider.settings = safe
    identity = identity_service or _default_identity_service(settings=settings)
    crew = crew_service or _default_crew_service(settings=settings)
    runtime_validation_store = _runtime_validation_ledger_store(reimbursement)
    runtime_validation_ledger = (
        runtime_validation_store.list_items() if runtime_validation_store else []
    )
    if getattr(chat, "memory_store", None) is None:
        chat.memory_store = memory
    if getattr(crew, "_directory", None) is None:
        # Same post-construction injection as finance/chat: give the crew channel
        # real member display names without coupling CrewService to identity.
        crew._directory = _member_directory(identity)
    if harness_backed:
        # Product mode is deliberately a business adapter only. Constructing
        # the Python execution kernel/runtime here would create a second Agent
        # authority and start the legacy scheduler in the lifespan below.
        execution = kernel = runtime = None
        owns_execution_store = False
    else:
        execution, kernel, runtime, owns_execution_store = _resolve_execution_components(
            execution_store=execution_store,
            execution_kernel=execution_kernel,
            execution_runtime=execution_runtime,
            crew=crew,
            memory=memory,
            settings=chat_settings,
        )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if runtime is not None:
            await runtime.start()
        try:
            yield
        finally:
            if runtime is not None:
                await runtime.stop()
            if owns_execution_store and execution is not None:
                execution.close()

    app = FastAPI(title="Anna Reimbursement MVP", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.reimbursement = reimbursement
    app.state.hiker = hiker
    app.state.associate = associate
    app.state.create = create
    app.state.chat = chat
    app.state.memory = memory
    app.state.identity = identity
    app.state.crew = crew
    app.state.execution_store = execution
    app.state.execution_kernel = kernel
    app.state.execution_runtime = runtime
    app.state.product_mode = harness_backed
    app.state.harness_client = host
    app.state.business_mode_config = mode_config

    # Shared planning collaborators use the same Host task contract in product
    # mode. The domain services keep their existing deterministic fallbacks and
    # validation; only their model-call seam changes.
    crew_harness_runtime = HostHarnessRuntime(host) if harness_backed and host else None
    decomposition = (
        CrewDecompositionService(harness_runtime=crew_harness_runtime, settings=chat_settings)
        if crew_harness_runtime is not None
        else CrewDecompositionService()
    )
    matching = (
        CrewMatchingService(harness_runtime=crew_harness_runtime, settings=chat_settings)
        if crew_harness_runtime is not None
        else CrewMatchingService()
    )
    command_drafting = (
        CommandDraftingService(harness_runtime=crew_harness_runtime, settings=chat_settings)
        if crew_harness_runtime is not None
        else CommandDraftingService()
    )

    # The no-login desktop user is a real local identity — Crew/team routes
    # accept it as a fallback (like every other surface), so the default
    # token-less desktop experience is usable, not a permanent 401.
    _local_session = lambda: local_session_identity(reimbursement)  # noqa: E731

    app.include_router(session_routes.build_router(reimbursement, identity))
    app.include_router(auth_routes.build_router(identity, local_session=_local_session))
    app.include_router(
        crew_routes.build_router(
            crew,
            identity,
            decomposition,
            matching,
            execution_kernel=kernel,
            execution_store=execution,
            execution_runtime=runtime,
            memory_store=memory,
            # B3: read-only reimbursement projection feeds the inbox「等我审」lane
            # + GET /api/crew/approvals (four-step stepper, zero writes back).
            reimbursement=reimbursement,
            command_drafting=command_drafting,
            local_session=_local_session,
            # R-B: Agent 自动触发 + 自动推进 (assign agent→跑 / 评审通过→下游自动指派+跑).
            auto_pilot=True,
            harness_client=host,
            product_mode=harness_backed,
        )
    )
    app.include_router(chat_routes.build_router(chat, harness_client=host, product_mode=harness_backed))
    app.include_router(workdirs_routes.build_router())
    app.include_router(
        hiker_routes.build_router(
            hiker,
            harness_client=host,
            product_mode=harness_backed,
        )
    )
    # Product mode has one Agent authority (the Node Host). Do not retain a
    # configurable Python v2 sidecar bridge that could become a silent second
    # execution path.
    v2_bridge = None if harness_backed else (harness_v2_bridge or HarnessV2Bridge.from_env())
    app.state.harness_v2_bridge = v2_bridge
    app.include_router(harness_v2_routes.build_router(v2_bridge))
    app.include_router(associate_routes.build_router(associate))
    app.include_router(create_routes.build_router(create, harness_client=host, product_mode=harness_backed))
    app.include_router(reimbursement_routes.build_router(reimbursement, harness_client=host, product_mode=harness_backed))
    app.include_router(
        admin_runtime_routes.build_router(
            reimbursement,
            associate,
            hiker,
            runtime_validation_store,
            runtime_validation_ledger,
            product_mode=harness_backed,
        )
    )
    app.include_router(
        admin_governance_routes.build_router(
            reimbursement,
            associate,
            hiker,
            create,
            chat,
            memory,
            runtime_validation_store,
            runtime_validation_ledger,
        )
    )

    if harness_backed and host is not None:
        app.include_router(
            business_routes.build_router(
                hiker=hiker,
                crew=crew,
                chat=chat,
                identity=identity,
                memory=memory,
                reimbursement=reimbursement,
                service_token=mode_config.service_token,
            )
        )

    _mount_desktop_shell(app)

    return app


def _default_reimbursement_orchestrator(
    *, settings: RuntimeSettings | None = None
) -> ReimbursementOrchestrator:
    settings = settings or RuntimeSettings.from_env()
    state_store = (
        SQLiteReimbursementStateStore(settings.state_db_path)
        if settings.state_db_path
        else None
    )
    return ReimbursementOrchestrator(settings=settings, state_store=state_store)


def _default_associate_orchestrator(
    *, settings: RuntimeSettings | None = None
) -> AssociateReceivablesOrchestrator:
    settings = settings or RuntimeSettings.from_env()
    state_store = (
        SQLiteAssociateStateStore(settings.state_db_path)
        if settings.state_db_path
        else None
    )
    return AssociateReceivablesOrchestrator(settings=settings, state_store=state_store)


def _runtime_validation_ledger_store(
    reimbursement: ReimbursementOrchestrator,
) -> SQLiteRuntimeValidationLedgerStore | None:
    state_db_path = _runtime_state_db_path(reimbursement)
    if not state_db_path:
        return None
    return SQLiteRuntimeValidationLedgerStore(state_db_path)


def _runtime_state_db_path(reimbursement: ReimbursementOrchestrator) -> str | None:
    for settings in (
        getattr(reimbursement, "settings", None),
        getattr(getattr(reimbursement, "model_provider", None), "settings", None),
        getattr(getattr(reimbursement, "adapter", None), "settings", None),
    ):
        state_db_path = getattr(settings, "state_db_path", None)
        if state_db_path:
            return str(state_db_path)
    return None


def _default_run_store(settings: RuntimeSettings | None = None) -> SQLiteRunStore | None:
    """L2 chat/create run store — co-located with the state DB (config.py).

    ``runs_db_path`` defaults to ``<state-db dir>/anna-runs.sqlite3`` so it
    inherits whatever isolation a caller applied to ``ANNA_STATE_DB_PATH`` (the
    agent-run-ledger test, tmp-dir deployments); it is effectively always set.
    """
    settings = settings or RuntimeSettings.from_env()
    if not settings.runs_db_path:
        return None
    return SQLiteRunStore(settings.runs_db_path)


def _default_execution_store(settings: RuntimeSettings | None = None) -> SQLiteExecutionStore:
    settings = settings or RuntimeSettings.from_env()
    if settings.state_db_path:
        db_path = Path(settings.state_db_path).parent / "anna-executions.sqlite3"
    else:
        db_path = Path(".anna/state/anna-executions.sqlite3")
    return SQLiteExecutionStore(db_path)


def _default_execution_runtime(
    *,
    execution_store: SQLiteExecutionStore,
    crew: CrewService,
    memory: BusinessMemoryStore,
    settings: RuntimeSettings,
) -> AgentExecutionRuntime:
    adapter = QueryEngineLoopAdapter(
        crew_store=crew._store,
        settings=settings,
        memory_store=memory,
    )
    projector = CrewExecutionProjector(
        crew_store=crew._store,
        execution_store=execution_store,
    )
    return AgentExecutionRuntime(
        store=execution_store,
        adapter=adapter,
        projector=projector,
        worker_count=max(1, settings.concurrency_per_workspace_runs),
    )


def _resolve_execution_components(
    *,
    execution_store: SQLiteExecutionStore | None,
    execution_kernel: AgentExecutionKernel | None,
    execution_runtime: AgentExecutionRuntime | None,
    crew: CrewService,
    memory: BusinessMemoryStore,
    settings: RuntimeSettings,
) -> tuple[SQLiteExecutionStore, AgentExecutionKernel, AgentExecutionRuntime, bool]:
    provided = [item is not None for item in (execution_store, execution_kernel, execution_runtime)]
    owns_store = not any(provided)
    kernel_store = getattr(execution_kernel, "_store", None) if execution_kernel else None
    runtime_store = getattr(execution_runtime, "_store", None) if execution_runtime else None
    stores = [
        store
        for store in (execution_store, kernel_store, runtime_store)
        if store is not None
    ]
    if stores:
        resolved_store = stores[0]
        if any(store is not resolved_store for store in stores[1:]):
            raise ValueError("execution_store, execution_kernel, and execution_runtime must share one store")
    else:
        resolved_store = _default_execution_store()
    kernel = execution_kernel or AgentExecutionKernel(resolved_store)
    runtime = execution_runtime or _default_execution_runtime(
        execution_store=resolved_store,
        crew=crew,
        memory=memory,
        settings=settings,
    )
    if getattr(kernel, "_store", None) is not resolved_store:
        raise ValueError("execution_kernel must use the resolved execution_store")
    if getattr(runtime, "_store", None) is not resolved_store:
        raise ValueError("execution_runtime must use the resolved execution_store")
    return resolved_store, kernel, runtime, owns_store


def _default_memory_store(settings: RuntimeSettings | None = None) -> BusinessMemoryStore:
    settings = settings or RuntimeSettings.from_env()
    return BusinessMemoryStore(settings.memory_db_path or ".anna/state/anna-memory.sqlite3")


def _default_identity_service(settings: RuntimeSettings | None = None) -> IdentityService:
    settings = settings or RuntimeSettings.from_env()
    db_path = settings.state_db_path or ".anna/state/anna-identity.sqlite3"
    return IdentityService(SQLiteIdentityStore(db_path))


def _default_crew_service(settings: RuntimeSettings | None = None) -> CrewService:
    settings = settings or RuntimeSettings.from_env()
    db_path = settings.state_db_path or ".anna/state/anna-crew.sqlite3"
    return CrewService(SQLiteCrewStore(db_path))


def _member_directory(identity: IdentityService) -> Callable[[str], str | None]:
    """member_id -> display_name resolver, for Anna's channel rows."""
    def resolve(member_id: str) -> str | None:
        account = identity.store.get_account(member_id)
        return account.display_name if account else None
    return resolve


def _mount_desktop_shell(app: FastAPI) -> None:
    dist_dir = Path.cwd() / "dist"
    index_path = dist_dir / "index.html"
    assets_dir = dist_dir / "assets"
    if not index_path.exists():
        return
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="desktop-assets")

    @app.get("/", include_in_schema=False)
    def get_desktop_index() -> FileResponse:
        return FileResponse(index_path)

    @app.get("/{full_path:path}", include_in_schema=False)
    def get_desktop_route(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(index_path)


def _model_visible_reimbursement_tools(
    reimbursement: ReimbursementOrchestrator,
    mcp_status: dict[str, Any] | None = None,
) -> list[dict]:
    mcp_status = mcp_status or reimbursement.adapter.status()
    discovered_tools = (
        mcp_status.get("tools", [])
        if isinstance(mcp_status.get("tools"), list)
        else []
    )
    try:
        skill = reimbursement.skill_loader.load(
            reimbursement.settings.reimbursement_skill_id
        )
    except SkillLoaderError:
        return reimbursement.tool_registry.model_visible_tools(
            discovered_tools=discovered_tools
        )
    return reimbursement.tool_registry.model_visible_tools(
        skill,
        discovered_tools=discovered_tools,
    )


def _runtime_validation_draft(settings: RuntimeSettings | None = None) -> dict[str, Any]:
    if settings and isinstance(settings.reimbursement_probe_draft, dict):
        sanitized = _sanitize_reimbursement_probe_draft(settings.reimbursement_probe_draft)
        if sanitized is not None:
            return sanitized
    return {
        "category": "transport",
        "amount": 1,
        "currency": "CNY",
        "expense_date": date.today().isoformat(),
        "merchant": "Anna runtime validation",
        "reason": "Anna runtime MCP read probe",
        "department_id": "runtime-validation",
        "cost_center_id": "runtime-validation",
        "attachments": [],
    }


def _runtime_validation_draft_source(settings: RuntimeSettings | None = None) -> str:
    if (
        settings
        and isinstance(settings.reimbursement_probe_draft, dict)
        and _sanitize_reimbursement_probe_draft(settings.reimbursement_probe_draft)
    ):
        return "runtime_config"
    return "default"


app = create_app()


def _bootstrap_demo_workspace(application: FastAPI) -> None:
    """Ensure the demo Crew workspace exists so login works out of the box on a
    fresh desktop/dev launch. Idempotent (no-op if already seeded) and must never
    block startup."""
    try:
        from services.identity.app.seed import seed_demo_workspace

        identity = getattr(application.state, "identity", None)
        store = getattr(identity, "store", None)
        if store is not None:
            seed_demo_workspace(store)
    except Exception:  # pragma: no cover - bootstrap must never crash the app
        pass


_bootstrap_demo_workspace(app)
