from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from services.api.app.harness_v2_bridge import HarnessV2Bridge, HarnessV2BridgeError
from services.runtime.app.harness_catalog import V2_SURFACE_IDS, build_v2_capabilities


def build_router(bridge: HarnessV2Bridge | None = None) -> APIRouter:
    router = APIRouter()

    @router.get("/api/harness/v2/capabilities")
    def get_capabilities() -> dict:
        if bridge is not None:
            return _bridge_call(bridge.get_capabilities)
        return build_v2_capabilities()

    @router.post("/api/harness/v2/surfaces/{surface_id}/runs")
    def start_v2_surface_run(surface_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if surface_id not in V2_SURFACE_IDS:
            raise HTTPException(
                status_code=404,
                detail={"code": "unknown_v2_surface", "surface_id": surface_id},
            )
        if bridge is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "legacy_surface_not_migrated",
                    "surface_id": surface_id,
                    "status": "unsupported",
                    "reason": "v2_bridge_not_implemented",
                    "message": "The v2 Runtime bridge is not available for this surface.",
                },
            )
        result = _bridge_call(lambda: bridge.start_run(surface_id, payload))
        return JSONResponse(status_code=result.status_code, content=result.payload)

    @router.post("/api/harness/v2/surfaces/{surface_id}/runs/{run_id}/resume")
    def resume_v2_surface_run(
        surface_id: str,
        run_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if surface_id not in V2_SURFACE_IDS:
            raise HTTPException(
                status_code=404,
                detail={"code": "unknown_v2_surface", "surface_id": surface_id},
            )
        if bridge is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "v2_runtime_resume_unavailable",
                    "status": "unsupported",
                    "reason": "v2_bridge_not_implemented",
                },
            )
        result = _bridge_call(lambda: bridge.resume_run(surface_id, run_id, payload))
        return JSONResponse(status_code=result.status_code, content=result.payload)

    @router.get("/api/harness/v2/runs/{run_id}/events")
    def read_v2_run_events(
        run_id: str,
        workspace_id: str,
        channel_id: str,
        from_seq: int = Query(default=-1, ge=-1),
    ) -> dict[str, Any]:
        if bridge is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "v2_event_reader_unavailable",
                    "reason": "v2_bridge_not_implemented",
                },
            )
        return _bridge_call(
            lambda: bridge.read_events(
                run_id,
                workspace_id=workspace_id,
                channel_id=channel_id,
                from_seq=from_seq,
            )
        )

    @router.get("/api/harness/v2/create/runs")
    def list_create_runs(workspace_id: str, channel_id: str) -> dict[str, Any]:
        if bridge is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "v2_create_list_unavailable",
                    "reason": "v2_bridge_not_implemented",
                },
            )
        return _bridge_call(
            lambda: bridge.list_create_runs(
                workspace_id=workspace_id,
                channel_id=channel_id,
            )
        )

    return router


def _bridge_call(call):
    try:
        return call()
    except HarnessV2BridgeError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "upstream": error.payload},
        ) from error
