from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.hiker.app.orchestrator import HikerOrchestrator
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.validation_ledger import SQLiteRuntimeValidationLedgerStore

from ..projections.egress import egress_projection
from ..projections.runtime_status import (
    _model_status,
    _runtime_config_status,
    _skill_registry_item,
    _skill_status,
)
from ..projections.validation_ledger import (
    _runtime_validation_ledger_item,
    _runtime_validation_ledger_response,
    _runtime_validation_report_response,
)
from ..redaction import _redact_runtime_status
from ..runtime_config import (
    _active_runtime_config_path,
    _read_runtime_config_file,
    _runtime_config_file_response,
    _write_runtime_config_file,
)
from ..schemas import AddModelProfileRequest, UpdateRuntimeConfigRequest
from ..validators.runtime import (
    _runtime_validation_fingerprint,
    _runtime_validation_response,
)


def _model_visible_reimbursement_tools(
    reimbursement: ReimbursementOrchestrator,
    mcp_status: dict[str, Any] | None = None,
) -> list[dict]:
    # Resolved through services.api.app.main at call time so tests can
    # monkeypatch main._model_visible_reimbursement_tools.
    from services.api.app import main as api_main

    return api_main._model_visible_reimbursement_tools(reimbursement, mcp_status)


def build_router(
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
    hiker: HikerOrchestrator,
    runtime_validation_store: SQLiteRuntimeValidationLedgerStore | None,
    runtime_validation_ledger: list[dict[str, Any]],
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/admin/mcp/reimbursement/status")
    def get_reimbursement_mcp_status() -> dict:
        return _redact_runtime_status(reimbursement.adapter.status())

    @router.get("/api/admin/mcp/reimbursement/tools")
    def get_reimbursement_mcp_tools() -> dict:
        mcp_status = _redact_runtime_status(reimbursement.adapter.status())
        return {
            "runtime": "reimbursement-tool-registry",
            "tools": _model_visible_reimbursement_tools(reimbursement, mcp_status),
        }

    @router.get("/api/admin/runtime/status")
    def get_runtime_status() -> dict:
        model_settings = reimbursement.model_provider.settings
        mcp_settings = reimbursement.adapter.settings
        mcp_status = _redact_runtime_status(reimbursement.adapter.status())
        erp_mcp_status = _redact_runtime_status(associate.adapter.status())
        hiker_mcp_status = _redact_runtime_status(hiker.adapter.status())
        return {
            "scheduler": {
                "execution_mode": "local",
                "runs_while_app_closed": False,
                "recovery_mode": "explicit",
            },
            "model": _model_status(model_settings),
            "reimbursement_mcp": mcp_status,
            "erp_mcp": erp_mcp_status,
            "hiker_mcp": hiker_mcp_status,
            "skill": _skill_status(
                reimbursement.skill_loader,
                reimbursement.settings.reimbursement_skill_id,
            ),
            "tools": _model_visible_reimbursement_tools(reimbursement, mcp_status),
            "config": _runtime_config_status(
                model_settings,
                mcp_settings,
                associate.adapter.settings,
                hiker.adapter.settings,
            ),
        }

    @router.get("/api/admin/egress")
    def get_egress_disclosure() -> dict:
        """J4 数据出境披露:数据到底会去哪(诚实面,v1 纯披露)。

        目的地取自各自真实的 settings 源(连接器各自装配,见 ``_runtime_config_status``)。

        **零探针**:这条路由不调用任何 ``adapter.status()``。每次 status() 都是一次
        到用户服务器的 JSON-RPC 往返(30s 超时),而设置页本来就同时拉
        ``/api/admin/runtime/status``(同样探那三个)—— 打开一张「我只往你配置的端点
        发数据」的卡片,却因此自己发起六次出境请求,是这一片最难看的自相矛盾。
        探针态由前端把它手上那份 runtime status 合并进卡片(同一份真值,零额外请求),
        这里只做纯读:没探过就 ``last_probe_status: None``,不猜。
        """
        return egress_projection(
            reimbursement.model_provider.settings,
            mcp_settings=reimbursement.adapter.settings,
            erp_settings=associate.adapter.settings,
            hiker_settings=hiker.adapter.settings,
        )

    @router.get("/api/admin/runtime/skills")
    def get_runtime_skills() -> dict:
        active_skill_id = reimbursement.settings.reimbursement_skill_id
        return {
            "active_skill_id": active_skill_id,
            "skills": [
                _skill_registry_item(skill, active_skill_id)
                for skill in reimbursement.skill_loader.list()
            ],
        }

    @router.get("/api/admin/runtime/config")
    def get_runtime_config() -> dict:
        return _runtime_config_file_response(
            _active_runtime_config_path(reimbursement),
            requires_restart_after_save=False,
        )

    @router.put("/api/admin/runtime/config")
    def update_runtime_config(request: UpdateRuntimeConfigRequest) -> dict:
        config_path = _active_runtime_config_path(reimbursement)
        _write_runtime_config_file(config_path, request.model_dump(exclude_unset=True))
        return _runtime_config_file_response(
            config_path,
            requires_restart_after_save=True,
        )

    @router.post("/api/admin/runtime/model-profiles")
    def add_model_profile(request: AddModelProfileRequest) -> dict:
        """P3 refinement - server-side profile merge (secrets never round-trip)."""
        config_path = _active_runtime_config_path(reimbursement)
        config = _read_runtime_config_file(config_path)
        profiles = [p for p in config.get("model_profiles", []) if isinstance(p, dict)]
        profile_id = request.id.strip()
        if not profile_id or profile_id == "default":
            raise HTTPException(status_code=422, detail="invalid profile id")
        if any(str(p.get("id")) == profile_id for p in profiles):
            raise HTTPException(status_code=409, detail="profile id already exists")
        entry = request.model_dump()
        entry["id"] = profile_id
        if not entry.get("api_key"):
            entry.pop("api_key", None)
        profiles.append(entry)
        _write_runtime_config_file(config_path, {"model_profiles": profiles})
        return _runtime_config_file_response(config_path, requires_restart_after_save=True)

    @router.delete("/api/admin/runtime/model-profiles/{profile_id}")
    def delete_model_profile(profile_id: str) -> dict:
        config_path = _active_runtime_config_path(reimbursement)
        config = _read_runtime_config_file(config_path)
        profiles = [p for p in config.get("model_profiles", []) if isinstance(p, dict)]
        remaining = [p for p in profiles if str(p.get("id")) != profile_id]
        if len(remaining) == len(profiles):
            raise HTTPException(status_code=404, detail="profile not found")
        _write_runtime_config_file(config_path, {"model_profiles": remaining})
        return _runtime_config_file_response(config_path, requires_restart_after_save=True)

    @router.post("/api/admin/runtime/validate")
    async def validate_runtime() -> dict:
        result = await _runtime_validation_response(reimbursement, associate)
        item = _runtime_validation_ledger_item(
            result,
            validation_id=f"validation_{len(runtime_validation_ledger) + 1:03d}",
            runtime_fingerprint=_runtime_validation_fingerprint(reimbursement, associate),
        )
        if runtime_validation_store:
            runtime_validation_store.save_item(item)
        runtime_validation_ledger.insert(0, item)
        del runtime_validation_ledger[20:]
        return result

    @router.get("/api/admin/runtime/validation-ledger")
    def get_runtime_validation_ledger() -> dict:
        items = (
            runtime_validation_store.list_items()
            if runtime_validation_store
            else runtime_validation_ledger
        )
        return _runtime_validation_ledger_response(items)

    @router.get("/api/admin/runtime/validation-report")
    def get_runtime_validation_report() -> dict:
        items = (
            runtime_validation_store.list_items()
            if runtime_validation_store
            else runtime_validation_ledger
        )
        return _runtime_validation_report_response(items)

    return router
