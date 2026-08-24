from fastapi.testclient import TestClient

from services.api.app.main import create_app


def test_session_identity_comes_from_runtime_environment(monkeypatch):
    monkeypatch.setenv("ANNA_WORKSPACE_ID", "demo-finance")
    monkeypatch.setenv("ANNA_WORKSPACE_NAME", "示例财务共享中心")
    monkeypatch.setenv("ANNA_USER_ID", "li-na")
    monkeypatch.setenv("ANNA_USER_DISPLAY_NAME", "李娜")

    client = TestClient(create_app())

    response = client.get("/api/session/current")

    assert response.status_code == 200
    assert response.json() == {
        "workspace_id": "demo-finance",
        "workspace_name": "示例财务共享中心",
        "user_id": "li-na",
        "user_display_name": "李娜",
        "role": "boss",
        "source": "local-runtime",
    }


def test_session_identity_uses_runtime_config_when_environment_is_empty(
    monkeypatch,
    tmp_path,
):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        """
        {
          "workspace_id": "finance-shared-service",
          "workspace_name": "财务共享服务部",
          "user_id": "expense-owner",
          "user_display_name": "报销经办人"
        }
        """,
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_WORKSPACE_ID", raising=False)
    monkeypatch.delenv("ANNA_WORKSPACE_NAME", raising=False)
    monkeypatch.delenv("ANNA_USER_ID", raising=False)
    monkeypatch.delenv("ANNA_USER_DISPLAY_NAME", raising=False)

    client = TestClient(create_app())

    response = client.get("/api/session/current")

    assert response.status_code == 200
    assert response.json()["workspace_id"] == "finance-shared-service"
    assert response.json()["user_id"] == "expense-owner"
