from fastapi.testclient import TestClient

from services.api.app.main import create_app


def test_local_runtime_serves_built_desktop_shell_from_root():
    client = TestClient(create_app())

    response = client.get("/")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert '<div id="root"></div>' in response.text
    assert "/assets/" in response.text


def test_local_runtime_does_not_treat_unknown_api_paths_as_desktop_routes():
    client = TestClient(create_app())

    response = client.get("/api/not-a-real-route")

    assert response.status_code == 404
