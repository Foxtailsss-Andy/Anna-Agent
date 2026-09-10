"""Workdirs — 工作空间(本地文件夹)注册表(Home 合并轮 M2/B2)。

UI 名「工作空间」;后端命名 workdir 以避开既有租户概念 workspace_id(identity)。
真值纪律:POST 校验路径真实存在且为目录;列表按 last_used_at 倒序;
持久化 = JSON 文件(跟随 .anna/state 惯例),内容仅 {id,name,path,last_used_at}。
文件夹内容注入与读写工具属 B2 引擎侧,不在本路由。
"""

from __future__ import annotations

import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Callable

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

# B2:JSON 读写与 store 路径上移共享模块(引擎侧 run 上下文注入复用同一份真值),
# 本路由行为不变。
from services.runtime.app.workdir_store import load_workdirs as _load
from services.runtime.app.workdir_store import save_workdirs as _save
from services.identity.app.service import IdentityService
from services.identity.app.schemas import SessionIdentity

from ..security import _assert_workspace_access, _resolve_product_identity

_LOCK = threading.Lock()


def _workdir_id(norm_path: str) -> str:
    return hashlib.sha1(norm_path.encode("utf-8")).hexdigest()[:12]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AddWorkdirRequest(BaseModel):
    path: str
    name: str | None = None


def build_router(
    *,
    identity: IdentityService | None = None,
    product_mode: bool = False,
    local_session: Callable[[], SessionIdentity] | None = None,
) -> APIRouter:
    router = APIRouter()

    def request_owner(
        authorization: str | None,
        workspace_id: str,
        user_id: str,
    ) -> tuple[str, str, bool]:
        if not product_mode:
            # The original desktop API is header-scoped. Product-only bearer
            # handling must not change its historical semantics.
            return workspace_id, user_id, True
        resolved, local_identity = _resolve_product_identity(
            authorization,
            workspace_id,
            user_id,
            identity=identity,
            local_session=local_session,
        )
        return resolved.workspace_id, resolved.user_id, local_identity

    def visible(item: dict, workspace_id: str, user_id: str, local_identity: bool) -> bool:
        owner_workspace = item.get("owner_workspace_id")
        owner_user = item.get("owner_actor_user_id")
        if owner_workspace is None and owner_user is None:
            return not product_mode or local_identity
        return owner_workspace == workspace_id and owner_user == user_id

    @router.get("/api/workdirs")
    def list_workdirs(
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
        authorization: str | None = Header(default=None),
    ) -> dict:
        workspace_id, user_id, local_identity = request_owner(
            authorization, anna_workspace_id, anna_user_id,
        )
        _assert_workspace_access(workspace_id, workspace_id, user_id)
        items = [item for item in _load() if visible(item, workspace_id, user_id, local_identity)]
        items.sort(key=lambda it: str(it.get("last_used_at") or ""), reverse=True)
        return {"workdirs": items}

    @router.post("/api/workdirs")
    def add_workdir(
        request: AddWorkdirRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
        authorization: str | None = Header(default=None),
    ) -> dict:
        workspace_id, user_id, local_identity = request_owner(
            authorization, anna_workspace_id, anna_user_id,
        )
        _assert_workspace_access(workspace_id, workspace_id, user_id)
        raw = (request.path or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="path is required")
        p = Path(raw).expanduser()
        if not p.exists():
            raise HTTPException(status_code=400, detail=f"path does not exist: {raw}")
        if not p.is_dir():
            raise HTTPException(status_code=400, detail=f"path is not a directory: {raw}")
        norm = str(p.resolve())
        wid = _workdir_id(norm)
        name = (request.name or "").strip() or p.resolve().name or norm
        with _LOCK:
            items = _load()
            for it in items:
                if it.get("id") == wid and visible(it, workspace_id, user_id, local_identity):
                    it["last_used_at"] = _now()
                    _save(items)
                    return dict(it)
            item = {
                "id": wid,
                "name": name,
                "path": norm,
                "last_used_at": _now(),
                **({
                    "owner_workspace_id": workspace_id,
                    "owner_actor_user_id": user_id,
                } if product_mode else {}),
            }
            items.append(item)
            _save(items)
        return item

    @router.post("/api/workdirs/{workdir_id}/touch")
    def touch_workdir(
        workdir_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
        authorization: str | None = Header(default=None),
    ) -> dict:
        workspace_id, user_id, local_identity = request_owner(
            authorization, anna_workspace_id, anna_user_id,
        )
        _assert_workspace_access(workspace_id, workspace_id, user_id)
        with _LOCK:
            items = _load()
            for it in items:
                if it.get("id") == workdir_id and visible(it, workspace_id, user_id, local_identity):
                    it["last_used_at"] = _now()
                    _save(items)
                    return dict(it)
        raise HTTPException(status_code=404, detail="workdir not found")

    @router.delete("/api/workdirs/{workdir_id}")
    def delete_workdir(
        workdir_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
        authorization: str | None = Header(default=None),
    ) -> dict:
        workspace_id, user_id, local_identity = request_owner(
            authorization, anna_workspace_id, anna_user_id,
        )
        _assert_workspace_access(workspace_id, workspace_id, user_id)
        with _LOCK:
            items = _load()
            kept = [
                it for it in items
                if it.get("id") != workdir_id or not visible(it, workspace_id, user_id, local_identity)
            ]
            if len(kept) == len(items):
                raise HTTPException(status_code=404, detail="workdir not found")
            _save(kept)
        return {"deleted": workdir_id}

    return router
