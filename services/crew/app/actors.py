from __future__ import annotations

SYSTEM_ANNA_ACTOR_ID = "anna"
SYSTEM_ACTOR_IDS = frozenset({SYSTEM_ANNA_ACTOR_ID})


def is_system_actor(actor_id: str | None) -> bool:
    return bool(actor_id) and actor_id in SYSTEM_ACTOR_IDS
