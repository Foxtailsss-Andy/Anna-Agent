"""Home 合并轮 B2 — workdir_store 共享模块(注册表读取 + 文件树上下文)。

纯函数真值口径:workdir_context 只报真实存在的文件(深度/条目代码门,
IO 异常降级空串——ADR-002 无真值不显示);resolve_workdir 按 env
ANNA_WORKDIRS_PATH 指向的 JSON 注册表命中/未命中。
"""
import json

from services.runtime.app.workdir_store import (
    resolve_valid_workdir,
    resolve_workdir,
    workdir_context,
    workdir_system_context,
)


# --- workdir_context ---------------------------------------------------------


def test_workdir_context_lists_files_and_marks_dirs(tmp_path):
    (tmp_path / "a.txt").write_text("A", encoding="utf-8")
    sub = tmp_path / "b"
    sub.mkdir()
    (sub / "c.txt").write_text("C", encoding="utf-8")

    lines = workdir_context(str(tmp_path)).splitlines()

    assert lines == ["a.txt", "b/", "b/c.txt"]


def test_workdir_context_depth_capped_at_two(tmp_path):
    deep = tmp_path / "l1" / "l2" / "l3"
    deep.mkdir(parents=True)
    (tmp_path / "l1" / "f1.txt").write_text("1", encoding="utf-8")
    (tmp_path / "l1" / "l2" / "f2.txt").write_text("2", encoding="utf-8")
    (deep / "f3.txt").write_text("3", encoding="utf-8")

    lines = workdir_context(str(tmp_path)).splitlines()

    # 深度 1-2 全在(l2/ 自身是深度 2 的条目);深度 3 起裁剪。
    assert "l1/" in lines
    assert "l1/f1.txt" in lines
    assert "l1/l2/" in lines
    assert "l1/l2/f2.txt" not in lines
    assert all("f3.txt" not in line for line in lines)


def test_workdir_context_entry_cap_appends_truncation_line(tmp_path):
    for i in range(5):
        (tmp_path / f"f{i}.txt").write_text("x", encoding="utf-8")

    lines = workdir_context(str(tmp_path), max_entries=3).splitlines()

    assert len(lines) == 4
    assert lines[-1] == "……（仅列前 3 项）"
    assert lines[:3] == ["f0.txt", "f1.txt", "f2.txt"]


def test_workdir_context_skips_noise_dirs(tmp_path):
    for noise in (".git", "node_modules", ".venv", "__pycache__"):
        d = tmp_path / noise
        d.mkdir()
        (d / "inside.txt").write_text("x", encoding="utf-8")
    (tmp_path / "keep.txt").write_text("k", encoding="utf-8")

    lines = workdir_context(str(tmp_path)).splitlines()

    assert lines == ["keep.txt"]


def test_workdir_context_missing_path_returns_empty(tmp_path):
    assert workdir_context(str(tmp_path / "nope")) == ""


def test_workdir_context_file_path_returns_empty(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("x", encoding="utf-8")
    assert workdir_context(str(f)) == ""


# --- resolve_workdir ---------------------------------------------------------


def _write_store(tmp_path, monkeypatch, items: list[dict]) -> None:
    store = tmp_path / "workdirs.json"
    store.write_text(
        json.dumps({"workdirs": items}, ensure_ascii=False), encoding="utf-8"
    )
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(store))


def test_resolve_workdir_hit_returns_id_name_path(tmp_path, monkeypatch):
    folder = tmp_path / "proj"
    folder.mkdir()
    _write_store(
        tmp_path,
        monkeypatch,
        [{"id": "wd_1", "name": "proj", "path": str(folder), "last_used_at": "t"}],
    )

    assert resolve_workdir("wd_1") == {"id": "wd_1", "name": "proj", "path": str(folder)}
    assert resolve_workdir("wd_other") is None


def test_resolve_workdir_missing_store_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(tmp_path / "absent.json"))
    assert resolve_workdir("wd_1") is None


def test_resolve_valid_workdir_requires_existing_directory(tmp_path, monkeypatch):
    gone = tmp_path / "deleted"
    _write_store(
        tmp_path,
        monkeypatch,
        [{"id": "wd_gone", "name": "deleted", "path": str(gone), "last_used_at": "t"}],
    )

    # 注册表命中但文件夹已不存在 → None(调用方审计 workdir.missing 并降级)。
    assert resolve_workdir("wd_gone") is not None
    assert resolve_valid_workdir("wd_gone") is None


def test_workdir_system_context_format(tmp_path):
    (tmp_path / "readme.md").write_text("hi", encoding="utf-8")
    text = workdir_system_context({"id": "wd_1", "name": "proj", "path": str(tmp_path)})

    assert text.startswith("[工作空间]\n")
    assert "名称：proj" in text
    assert f"根目录：{tmp_path}" in text
    assert "文件清单（≤2 层）：\nreadme.md" in text
