"""Workdir(工作空间)注册表共享存取 + 文件树上下文(Home 合并轮 B2)。

workdirs 的 JSON 读写从 ``services/api/app/routes/workdirs.py`` 上移至此,
API 路由与引擎侧(chat/create 的 run 上下文注入)共用一份真值:
store 路径 = env ``ANNA_WORKDIRS_PATH``,缺省 ``.anna/state/anna-workdirs.json``,
内容 ``{"workdirs": [{id,name,path,last_used_at}, ...]}``。

引擎侧只读:``resolve_workdir`` 按 id 取 {id,name,path};``workdir_context``
生成文件树摘要(纯函数,IO 异常一律降级为空串——ADR-002 无真值不显示);
``workdir_system_context`` 是注入 system prompt 的 [工作空间] 段唯一格式源。
"""

from __future__ import annotations

import json
import os
from pathlib import Path


# 噪声目录:体量大且对模型理解项目无益,清单与读工具都不进。
_SKIP_DIR_NAMES = frozenset({".git", "node_modules", ".venv", "__pycache__"})


def store_path() -> Path:
    root = os.getenv("ANNA_WORKDIRS_PATH")
    if root:
        return Path(root)
    return Path(".anna/state/anna-workdirs.json")


def load_workdirs() -> list[dict]:
    path = store_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = data.get("workdirs") if isinstance(data, dict) else None
    return [dict(it) for it in items] if isinstance(items, list) else []


def save_workdirs(items: list[dict]) -> None:
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"workdirs": items}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def resolve_workdir(
    workdir_id: str,
    *,
    owner_workspace_id: str | None = None,
    owner_actor_user_id: str | None = None,
    allow_legacy_local: bool = False,
) -> dict | None:
    """按 id 查注册表，可按服务端 owner 选择重复 ID 的记录。

    不带 owner 参数时保持历史 first-match 语义；带 owner 参数时只返回
    精确归属，或由可信 local identity 显式读取旧的无归属记录。
    """
    for it in load_workdirs():
        if it.get("id") != workdir_id:
            continue
        owner_selected = owner_workspace_id is not None or owner_actor_user_id is not None
        if owner_selected:
            if owner_workspace_id is None or owner_actor_user_id is None:
                return None
            exact_owner = (
                it.get("owner_workspace_id") == owner_workspace_id
                and it.get("owner_actor_user_id") == owner_actor_user_id
            )
            legacy_local = (
                allow_legacy_local
                and it.get("owner_workspace_id") is None
                and it.get("owner_actor_user_id") is None
            )
            if not exact_owner and not legacy_local:
                continue
        return {
            "id": str(it.get("id") or ""),
            "name": str(it.get("name") or ""),
            "path": str(it.get("path") or ""),
            **(
                {"owner_workspace_id": str(it["owner_workspace_id"])}
                if it.get("owner_workspace_id") is not None else {}
            ),
            **(
                {"owner_actor_user_id": str(it["owner_actor_user_id"])}
                if it.get("owner_actor_user_id") is not None else {}
            ),
        }
    return None


def resolve_valid_workdir(
    workdir_id: str,
    *,
    owner_workspace_id: str | None = None,
    owner_actor_user_id: str | None = None,
    allow_legacy_local: bool = False,
) -> dict | None:
    """``resolve_workdir`` + 路径仍真实存在的门。

    注册表命中但文件夹已删/路径失踪 → ``None``(调用方审计 ``workdir.missing``
    并诚实降级,run 照常进行)。可选 owner 参数沿用 ``resolve_workdir`` 的
    归属筛选，product 入口因此不会把同路径的其他 owner 当成当前目录。
    """
    workdir = resolve_workdir(
        workdir_id,
        owner_workspace_id=owner_workspace_id,
        owner_actor_user_id=owner_actor_user_id,
        allow_legacy_local=allow_legacy_local,
    )
    if workdir is None:
        return None
    path = workdir["path"]
    if not path or not Path(path).is_dir():
        return None
    return workdir


def workdir_context(path: str, *, max_depth: int = 2, max_entries: int = 200) -> str:
    """文件树摘要:相对路径逐行(正斜杠),目录带 ``/`` 后缀。

    深度 ≤ ``max_depth``(根下第一层 = 深度 1),条目 ≤ ``max_entries``
    (超出则末行加 ``…(仅列前 N 项)``);跳过 ``.git``/``node_modules``/
    ``.venv``/``__pycache__``;路径不存在或 IO 异常返回空串。
    每层内按名称(不分大小写)排序,输出确定。
    """
    root = Path(path)
    try:
        if not root.is_dir():
            return ""
    except OSError:
        return ""

    lines: list[str] = []
    truncated = False

    def _walk(directory: Path, depth: int, rel_prefix: str) -> None:
        nonlocal truncated
        try:
            entries = sorted(directory.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for entry in entries:
            if truncated:
                return
            try:
                is_dir = entry.is_dir()
            except OSError:
                continue
            if is_dir and entry.name in _SKIP_DIR_NAMES:
                continue
            if len(lines) >= max_entries:
                truncated = True
                return
            rel = f"{rel_prefix}{entry.name}"
            lines.append(f"{rel}/" if is_dir else rel)
            if is_dir and depth < max_depth:
                _walk(entry, depth + 1, f"{rel}/")

    try:
        _walk(root, 1, "")
    except OSError:
        return ""
    if truncated:
        lines.append(f"……（仅列前 {max_entries} 项）")
    return "\n".join(lines)


def workdir_system_context(workdir: dict) -> str:
    """注入 system prompt 的 [工作空间] 段——chat/create 共用的唯一格式源。"""
    return (
        "[工作空间]\n"
        f"名称：{workdir['name']}\n"
        f"根目录：{workdir['path']}\n"
        "文件清单（≤2 层）：\n"
        f"{workdir_context(workdir['path'])}"
    )
