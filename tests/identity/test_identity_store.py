from services.identity.app.passwords import hash_password, verify_password
from services.identity.app.schemas import Account, Membership
from services.identity.app.store import SQLiteIdentityStore


def _store(tmp_path):
    return SQLiteIdentityStore(tmp_path / "identity.sqlite3")


def test_create_and_get_workspace(tmp_path):
    store = _store(tmp_path)
    store.create_workspace("ws1", "Acme")
    workspace = store.get_workspace("ws1")
    assert workspace is not None
    assert workspace.name == "Acme"
    assert store.get_workspace("missing") is None


def test_create_account_and_get_by_email(tmp_path):
    store = _store(tmp_path)
    store.create_workspace("ws1", "Acme")
    account = Account(
        id="acc1", workspace_id="ws1", email="boss@acme.test",
        display_name="Boss", role="boss",
    )
    store.create_account(account, hash_password("pw"))
    creds = store.get_account_credentials("boss@acme.test")
    assert creds is not None
    fetched, password_hash = creds
    assert fetched.id == "acc1"
    assert verify_password("pw", password_hash) is True
    assert store.get_account_credentials("nobody@acme.test") is None


def test_get_account_by_id(tmp_path):
    store = _store(tmp_path)
    store.create_workspace("ws1", "Acme")
    store.create_account(
        Account(id="acc1", workspace_id="ws1", email="a@x.test",
                display_name="A", role="member"),
        hash_password("pw"),
    )
    assert store.get_account("acc1").display_name == "A"
    assert store.get_account("missing") is None


def test_list_members_is_scoped_by_workspace(tmp_path):
    store = _store(tmp_path)
    store.create_workspace("ws1", "Acme")
    store.create_workspace("ws2", "Other")
    store.create_team("t1", "ws1", "Core")
    store.create_team("t2", "ws2", "Core")
    for acc_id, ws in [("a1", "ws1"), ("a2", "ws1"), ("b1", "ws2")]:
        store.create_account(
            Account(id=acc_id, workspace_id=ws, email=f"{acc_id}@x.test",
                    display_name=acc_id, role="member"),
            hash_password("pw"),
        )
        store.add_membership(Membership(account_id=acc_id, workspace_id=ws,
                                        team_id="t1" if ws == "ws1" else "t2", role="member"))
    ws1_members = {m.id for m in store.list_members("ws1")}
    assert ws1_members == {"a1", "a2"}
    assert {m.id for m in store.list_members("ws2")} == {"b1"}


def test_session_create_get_delete(tmp_path):
    store = _store(tmp_path)
    store.create_session("tok123", account_id="acc1", workspace_id="ws1")
    session = store.get_session("tok123")
    assert session == {"account_id": "acc1", "workspace_id": "ws1"}
    store.delete_session("tok123")
    assert store.get_session("tok123") is None


def test_get_unknown_session_returns_none(tmp_path):
    store = _store(tmp_path)
    assert store.get_session("nope") is None
