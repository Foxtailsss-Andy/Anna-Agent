from services.identity.app.seed import (
    DEMO_ACCOUNTS,
    DEMO_WORKSPACE_ID,
    seed_demo_workspace,
)
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


def test_seed_creates_workspace_team_and_accounts(tmp_path):
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(store)
    assert store.get_workspace(DEMO_WORKSPACE_ID) is not None
    members = store.list_members(DEMO_WORKSPACE_ID)
    assert len(members) == len(DEMO_ACCOUNTS)


def test_seed_is_idempotent(tmp_path):
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(store)
    seed_demo_workspace(store)
    assert len(store.list_members(DEMO_WORKSPACE_ID)) == len(DEMO_ACCOUNTS)


def test_seeded_boss_can_login(tmp_path):
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(store)
    result = IdentityService(store).login("boss@anna.demo", "crew-demo")
    assert result.session.role == "产品"
