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

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

# B2:JSON 读写与 store 路径上移共享模块(引擎侧 run 上下文注入复用同一份真值),
# 本路由行为不变。
from services.runtime.app.workdir_store import load_workdirs as _load
from services.runtime.app.workdir_store import save_workdirs as _save

from ..security import _assert_workspace_access

_LOCK = threading.Lock()


def _workdir_id(norm_path: str) -> str:
    return hashlib.sha1(norm_path.encode("utf-8")).hexdigest()[:12]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AddWorkdirRequest(BaseModel):
    path: str
    name: str | None = None


def build_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/workdirs")
    def list_workdirs(
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_workspace_access(anna_workspace_id, anna_workspace_id, anna_user_id)
        items = _load()
        items.sort(key=lambda it: str(it.get("last_used_at") or ""), reverse=True)
        return {"workdirs": items}

    @router.post("/api/workdirs")
    def add_workdir(
        request: AddWorkdirRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_workspace_access(anna_workspace_id, anna_workspace_id, anna_user_id)
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
                if it.get("id") == wid:
                    it["last_used_at"] = _now()
                    _save(items)
                    return dict(it)
            item = {"id": wid, "name": name, "path": norm, "last_used_at": _now()}
            items.append(item)
            _save(items)
        return item

    @router.post("/api/workdirs/{workdir_id}/touch")
    def touch_workdir(
        workdir_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_workspace_access(anna_workspace_id, anna_workspace_id, anna_user_id)
        with _LOCK:
            items = _load()
            for it in items:
                if it.get("id") == workdir_id:
                    it["last_used_at"] = _now()
                    _save(items)
                    return dict(it)
        raise HTTPException(status_code=404, detail="workdir not found")

    @router.delete("/api/workdirs/{workdir_id}")
    def delete_workdir(
        workdir_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_workspace_access(anna_workspace_id, anna_workspace_id, anna_user_id)
        with _LOCK:
            items = _load()
            kept = [it for it in items if it.get("id") != workdir_id]
            if len(kept) == len(items):
                raise HTTPException(status_code=404, detail="workdir not found")
            _save(kept)
        return {"deleted": workdir_id}

    return router
