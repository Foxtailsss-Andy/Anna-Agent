from services.identity.app.passwords import hash_password
from services.identity.app.schemas import Account
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


def _two_tenant_service(tmp_path):
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    for ws in ("wsA", "wsB"):
        store.create_workspace(ws, ws.upper())
        store.create_team(f"t_{ws}", ws, "Core")
    store.create_account(
        Account(id="a_boss", workspace_id="wsA", email="a@a.test",
                display_name="A", role="boss"), hash_password("pw"))
    store.create_account(
        Account(id="b_boss", workspace_id="wsB", email="b@b.test",
                display_name="B", role="boss"), hash_password("pw"))
    return IdentityService(store)


def test_member_listing_does_not_cross_tenants(tmp_path):
    service = _two_tenant_service(tmp_path)
    a_ids = {m.id for m in service.list_members("wsA")}
    b_ids = {m.id for m in service.list_members("wsB")}
    assert a_ids == {"a_boss"}
    assert b_ids == {"b_boss"}
    assert a_ids.isdisjoint(b_ids)


def test_session_resolves_only_its_own_workspace(tmp_path):
    service = _two_tenant_service(tmp_path)
    token_a = service.login("a@a.test", "pw").token
    identity_a = service.resolve(token_a)
    assert identity_a.workspace_id == "wsA"
    # A's token must never surface B's workspace
    assert identity_a.workspace_id != "wsB"
