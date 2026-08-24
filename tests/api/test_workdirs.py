"""Home 合并轮 M2 — 工作空间(workdir)注册表 API。

真值纪律:POST 校验路径真实存在且为目录;重复注册幂等(同 id);
列表按 last_used_at 倒序;删除后不再出现。UI 名「工作空间」,
后端名 workdir(避开租户 workspace_id)。
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.api.app.main import create_app


HEADERS = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(tmp_path / "workdirs.json"))
    return TestClient(create_app())


def test_add_list_touch_delete_roundtrip(client, tmp_path):
    folder = tmp_path / "proj"
    folder.mkdir()

    created = client.post(
        "/api/workdirs", json={"path": str(folder)}, headers=HEADERS
    )
    assert created.status_code == 200
    item = created.json()
    assert item["name"] == "proj"
    assert Path(item["path"]) == folder.resolve()

    listed = client.get("/api/workdirs", headers=HEADERS).json()["workdirs"]
    assert [w["id"] for w in listed] == [item["id"]]

    touched = client.post(f"/api/workdirs/{item['id']}/touch", headers=HEADERS)
    assert touched.status_code == 200

    deleted = client.delete(f"/api/workdirs/{item['id']}", headers=HEADERS)
    assert deleted.status_code == 200
    assert client.get("/api/workdirs", headers=HEADERS).json()["workdirs"] == []


def test_add_rejects_missing_or_file_path(client, tmp_path):
    missing = client.post(
        "/api/workdirs", json={"path": str(tmp_path / "nope")}, headers=HEADERS
    )
    assert missing.status_code == 400
    assert "does not exist" in missing.json()["detail"]

    f = tmp_path / "a.txt"
    f.write_text("x", encoding="utf-8")
    not_dir = client.post("/api/workdirs", json={"path": str(f)}, headers=HEADERS)
    assert not_dir.status_code == 400
    assert "not a directory" in not_dir.json()["detail"]


def test_add_same_path_is_idempotent(client, tmp_path):
    folder = tmp_path / "same"
    folder.mkdir()
    first = client.post("/api/workdirs", json={"path": str(folder)}, headers=HEADERS).json()
    second = client.post("/api/workdirs", json={"path": str(folder)}, headers=HEADERS).json()
    assert first["id"] == second["id"]
    listed = client.get("/api/workdirs", headers=HEADERS).json()["workdirs"]
    assert len(listed) == 1
