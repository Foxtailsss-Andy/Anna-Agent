from __future__ import annotations

from services.identity.app.passwords import hash_password
from services.identity.app.schemas import Account, Membership
from services.identity.app.store import SQLiteIdentityStore

DEMO_WORKSPACE_ID = "ws_crew_demo"
DEMO_TEAM_ID = "team_crew_demo"
DEMO_PASSWORD = "crew-demo"

# (id, email, display_name, role, kind)
# `role` is the job/skill function used for assignment matching (feature_iteration
# gates + producer tasks are done by "产品", i.e. the Boss). The 2-tier permission
# (Boss vs member) is derived from project ownership, not this field.
# 旗舰演示班子:2 人(Boss=产品 / Andy=工程)+ 3 个 Agent(文案 / 设计 / 验收)。
DEMO_ACCOUNTS = [
    ("acc_boss", "boss@anna.demo", "Boss", "产品", "human"),
    ("acc_andy", "andy@anna.demo", "Andy", "工程", "human"),
    ("acc_agent_scribe", "scribe@anna.demo", "Agent·Scribe", "文案", "agent"),
    ("acc_agent_design", "design@anna.demo", "Agent·Design", "设计", "agent"),
    ("acc_agent_check", "check@anna.demo", "Agent·Check", "验收", "agent"),
]


def seed_demo_workspace(store: SQLiteIdentityStore) -> None:
    if store.get_workspace(DEMO_WORKSPACE_ID) is not None:
        return
    store.create_workspace(DEMO_WORKSPACE_ID, "Crew Demo Team")
    store.create_team(DEMO_TEAM_ID, DEMO_WORKSPACE_ID, "Core")
    for account_id, email, display_name, role, kind in DEMO_ACCOUNTS:
        store.create_account(
            Account(
                id=account_id, workspace_id=DEMO_WORKSPACE_ID, email=email,
                display_name=display_name, role=role, kind=kind,
            ),
            hash_password(DEMO_PASSWORD),
        )
        store.add_membership(
            Membership(account_id=account_id, workspace_id=DEMO_WORKSPACE_ID,
                       team_id=DEMO_TEAM_ID, role=role)
        )


def _main() -> None:
    from services.runtime.app.config import RuntimeSettings

    settings = RuntimeSettings.from_env()
    db_path = settings.state_db_path or ".anna/state/anna-identity.sqlite3"
    store = SQLiteIdentityStore(db_path)
    seed_demo_workspace(store)
    print(f"Seeded Crew demo workspace into {db_path}")
    print(f"Accounts (password='{DEMO_PASSWORD}'): "
          + ", ".join(email for _, email, *_ in DEMO_ACCOUNTS))


if __name__ == "__main__":
    _main()
