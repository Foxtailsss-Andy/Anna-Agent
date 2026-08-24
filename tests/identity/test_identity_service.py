import pytest

from services.identity.app.passwords import hash_password
from services.identity.app.schemas import Account
from services.identity.app.service import IdentityError, IdentityService
from services.identity.app.store import SQLiteIdentityStore


def _service(tmp_path):
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    store.create_workspace("ws1", "Acme")
    store.create_team("t1", "ws1", "Core")
    store.create_account(
        Account(id="acc1", workspace_id="ws1", email="boss@acme.test",
                display_name="Boss", role="boss"),
        hash_password("secret"),
    )
    return IdentityService(store)


def test_login_success_returns_token_and_identity(tmp_path):
    service = _service(tmp_path)
    result = service.login("boss@acme.test", "secret")
    assert result.token
    assert result.session.user_id == "acc1"
    assert result.session.workspace_id == "ws1"
    assert result.session.workspace_name == "Acme"
    assert result.session.role == "boss"


def test_login_wrong_password_raises(tmp_path):
    service = _service(tmp_path)
    with pytest.raises(IdentityError):
        service.login("boss@acme.test", "wrong")


def test_login_unknown_email_raises(tmp_path):
    service = _service(tmp_path)
    with pytest.raises(IdentityError):
        service.login("ghost@acme.test", "secret")


def test_resolve_token_then_logout(tmp_path):
    service = _service(tmp_path)
    token = service.login("boss@acme.test", "secret").token
    identity = service.resolve(token)
    assert identity is not None and identity.user_id == "acc1"
    service.logout(token)
    assert service.resolve(token) is None


def test_resolve_unknown_token_returns_none(tmp_path):
    service = _service(tmp_path)
    assert service.resolve("bogus") is None
