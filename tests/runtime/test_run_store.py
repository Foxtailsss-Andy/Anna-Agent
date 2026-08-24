"""L2 · SQLiteRunStore unit tests (P2 状态外置).

Pins the run-store mechanics the minutes-level gate
(``tests/gates/test_gate_p2_restart.py``) does not exhaustively cover: UPSERT
idempotency + created_at preservation, list ordering + identity/surface
filtering, thread listing (ASC, creation order), and the non-terminal → the
``interrupted`` startup sweep. On-disk SQLite, tmp-isolated.
"""
from services.chat.app.schemas import ChatRun
from services.runtime.app.run_store import (
    RESUMABLE_RUN_STATUSES,
    TERMINAL_RUN_STATUSES,
    SQLiteRunStore,
)


def _save(
    store: SQLiteRunStore,
    *,
    surface: str = "chat",
    run_id: str,
    thread_id: str | None = None,
    workspace_id: str = "demo",
    actor_user_id: str = "u_demo",
    status: str = "ready",
    created_at: str = "2026-01-01T00:00:00+00:00",
    payload: dict | None = None,
) -> None:
    store.save_run(
        surface=surface,
        run_id=run_id,
        thread_id=thread_id if thread_id is not None else run_id,
        workspace_id=workspace_id,
        actor_user_id=actor_user_id,
        status=status,
        created_at=created_at,
        payload=payload if payload is not None else {"id": run_id, "status": status},
    )


def _store(tmp_path) -> SQLiteRunStore:
    return SQLiteRunStore(tmp_path / "anna-runs.sqlite3")


# --- round-trip + rich payload fidelity ----------------------------------------


def test_save_then_get_round_trips_the_full_payload(tmp_path):
    store = _store(tmp_path)
    run = ChatRun(
        id="chat_run_001",
        workspace_id="demo",
        actor_user_id="u_demo",
        message="问题",
        thread_id="chat_run_001",
        status="ready",
        assistant_message="答案",
        artifacts=[{"kind": "page", "id": "a1", "title": "报告"}],
        plan=[{"id": "n1", "title": "步骤一", "status": "done"}],
    )
    payload = run.model_dump(mode="json")
    _save(store, run_id="chat_run_001", payload=payload)

    fetched = store.get_run("chat", "chat_run_001")
    assert fetched == payload  # deep-equal, artifacts + plan + everything intact
    assert ChatRun.model_validate(fetched) == run


def test_get_run_missing_returns_none(tmp_path):
    store = _store(tmp_path)
    assert store.get_run("chat", "nope") is None


# --- UPSERT idempotency + created_at preservation ------------------------------


def test_save_run_upsert_is_idempotent_and_updates_in_place(tmp_path):
    store = _store(tmp_path)
    _save(store, run_id="r1", status="generating", payload={"id": "r1", "status": "generating"})
    _save(store, run_id="r1", status="ready", payload={"id": "r1", "status": "ready", "answer": "x"})

    # A single row remains; the latest write wins.
    listed = store.list_runs("chat", "demo", "u_demo")
    assert len(listed) == 1
    assert store.get_run("chat", "r1") == {"id": "r1", "status": "ready", "answer": "x"}


def test_upsert_preserves_the_original_created_at(tmp_path):
    store = _store(tmp_path)
    _save(store, run_id="a", created_at="2026-01-01T00:00:00+00:00", status="generating")
    _save(store, run_id="b", created_at="2026-01-01T00:00:05+00:00", status="ready")
    # 'a' completes LATER but its terminal write carries a fresh timestamp — the
    # store must keep the ORIGINAL created_at so ordering stays stable.
    _save(store, run_id="a", created_at="2026-01-01T00:00:09+00:00", status="ready")

    ordered = [p["id"] for p in store.list_runs("chat", "demo", "u_demo")]
    assert ordered == ["b", "a"]  # b still newer — a's created_at was preserved


# --- list ordering + identity/surface filtering --------------------------------


def test_list_runs_is_created_at_descending(tmp_path):
    store = _store(tmp_path)
    _save(store, run_id="old", created_at="2026-01-01T00:00:01+00:00")
    _save(store, run_id="new", created_at="2026-01-01T00:00:03+00:00")
    _save(store, run_id="mid", created_at="2026-01-01T00:00:02+00:00")

    assert [p["id"] for p in store.list_runs("chat", "demo", "u_demo")] == [
        "new",
        "mid",
        "old",
    ]


def test_list_runs_filters_by_identity_and_surface(tmp_path):
    store = _store(tmp_path)
    _save(store, run_id="mine", workspace_id="demo", actor_user_id="u_demo")
    _save(store, run_id="other_user", workspace_id="demo", actor_user_id="u_other")
    _save(store, run_id="other_ws", workspace_id="ws2", actor_user_id="u_demo")
    _save(store, surface="create", run_id="other_surface", workspace_id="demo", actor_user_id="u_demo")

    ids = [p["id"] for p in store.list_runs("chat", "demo", "u_demo")]
    assert ids == ["mine"]


def test_list_runs_honors_limit(tmp_path):
    store = _store(tmp_path)
    for i in range(5):
        _save(store, run_id=f"r{i}", created_at=f"2026-01-01T00:00:0{i}+00:00")
    assert len(store.list_runs("chat", "demo", "u_demo", limit=2)) == 2


# --- thread listing: creation order ASC ----------------------------------------


def test_list_thread_runs_is_creation_order_ascending(tmp_path):
    store = _store(tmp_path)
    thread = "t1"
    _save(store, run_id="t_c", thread_id=thread, created_at="2026-01-01T00:00:03+00:00")
    _save(store, run_id="t_a", thread_id=thread, created_at="2026-01-01T00:00:01+00:00")
    _save(store, run_id="t_b", thread_id=thread, created_at="2026-01-01T00:00:02+00:00")
    _save(store, run_id="other_thread", thread_id="t2", created_at="2026-01-01T00:00:01+00:00")

    ids = [p["id"] for p in store.list_thread_runs("chat", thread, "demo", "u_demo")]
    assert ids == ["t_a", "t_b", "t_c"]  # ASC, and t2 excluded


def test_list_thread_runs_applies_identity_guard(tmp_path):
    store = _store(tmp_path)
    thread = "shared_thread"
    _save(store, run_id="alice", thread_id=thread, actor_user_id="u_alice")
    _save(store, run_id="bob", thread_id=thread, actor_user_id="u_bob")

    ids = [p["id"] for p in store.list_thread_runs("chat", thread, "demo", "u_alice")]
    assert ids == ["alice"]  # bob's turn on the same thread never leaks


# --- stale sweep: only non-terminal → interrupted ------------------------------


def test_mark_stale_interrupted_only_touches_non_terminal(tmp_path):
    store = _store(tmp_path)
    _save(store, run_id="running", status="generating", payload={"id": "running", "status": "generating"})
    _save(store, run_id="zombie", status="running", payload={"id": "zombie", "status": "running"})
    _save(store, run_id="done", status="ready", payload={"id": "done", "status": "ready"})
    _save(store, run_id="dead", status="failed", payload={"id": "dead", "status": "failed"})

    healed = store.mark_stale_interrupted("chat")
    assert healed == 2  # generating + running; ready + failed untouched

    # Column AND payload flipped for the non-terminal ones.
    assert store.get_run("chat", "running")["status"] == "interrupted"
    assert store.get_run("chat", "zombie")["status"] == "interrupted"
    # Terminal runs are left exactly as they were.
    assert store.get_run("chat", "done")["status"] == "ready"
    assert store.get_run("chat", "dead")["status"] == "failed"


def test_mark_stale_interrupted_appends_one_durable_error_frame(tmp_path):
    store = _store(tmp_path)
    _save(store, run_id="zombie", status="generating", payload={"id": "zombie", "status": "generating"})
    store.append_frame("chat", "zombie", 1, {"type": "step", "seq": 1})

    assert store.mark_stale_interrupted("chat") == 1
    frames = store.list_frames("chat", "zombie")
    assert [frame["seq"] for frame in frames] == [1, 2]
    assert frames[-1] == {
        "type": "error",
        "seq": 2,
        "message": "Run interrupted after process restart.",
        "run": {"id": "zombie", "status": "interrupted"},
    }
    assert store.mark_stale_interrupted("chat") == 0
    assert len(store.list_frames("chat", "zombie")) == 2


def test_mark_stale_interrupted_is_idempotent_and_surface_scoped(tmp_path):
    store = _store(tmp_path)
    _save(store, surface="chat", run_id="c1", status="generating", payload={"id": "c1", "status": "generating"})
    _save(store, surface="create", run_id="k1", status="validating", payload={"id": "k1", "status": "validating"})

    assert store.mark_stale_interrupted("chat") == 1
    # create's non-terminal run is untouched by a chat sweep.
    assert store.get_run("create", "k1")["status"] == "validating"
    # Second chat sweep is a no-op — interrupted is terminal.
    assert store.mark_stale_interrupted("chat") == 0
    assert store.get_run("chat", "c1")["status"] == "interrupted"

    # The create sweep heals its own surface.
    assert store.mark_stale_interrupted("create") == 1
    assert store.get_run("create", "k1")["status"] == "interrupted"


def test_interrupted_is_a_terminal_status(tmp_path):
    # Guards the sweep's own idempotency contract at the constant level.
    assert "interrupted" in TERMINAL_RUN_STATUSES
    assert {"ready", "ready_for_review", "saved", "failed"} <= TERMINAL_RUN_STATUSES
    assert "generating" not in TERMINAL_RUN_STATUSES
    assert "validating" not in TERMINAL_RUN_STATUSES


# --- run-id sequence seeding (no cross-restart id collision) --------------------


def test_max_run_sequence_finds_the_highest_suffix_per_surface(tmp_path):
    store = _store(tmp_path)
    _save(store, surface="chat", run_id="chat_run_001")
    _save(store, surface="chat", run_id="chat_run_007")
    _save(store, surface="chat", run_id="chat_run_zombie")  # non-numeric → ignored
    _save(store, surface="create", run_id="create_run_042")

    assert store.max_run_sequence("chat", "chat_run_") == 7
    assert store.max_run_sequence("create", "create_run_") == 42
    # Empty surface / no matching prefix → 0 (a fresh counter).
    assert store.max_run_sequence("chat", "nope_") == 0
    assert SQLiteRunStore(tmp_path / "empty.sqlite3").max_run_sequence("chat", "chat_run_") == 0


# --- WAL journaling: the per-frame write-through must not fsync per token delta --


def test_connection_uses_wal_journal_mode(tmp_path):
    # The L3a frame journal writes through one INSERT per frame on the event loop;
    # WAL (persisted in the DB file header, re-applied on every per-call connect)
    # trades a full fsync per commit for a cheap WAL append. A fresh store's
    # connection must therefore report WAL, paired with synchronous=NORMAL.
    store = _store(tmp_path)
    connection = store._connect()
    try:
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        synchronous = connection.execute("PRAGMA synchronous").fetchone()[0]
    finally:
        connection.close()
    assert journal_mode == "wal"
    assert synchronous == 1  # NORMAL — the standard WAL pairing


# --- L4a 续办: max_frame_seq is the resume floor; awaiting_continue survives ----


def test_max_frame_seq_is_the_resume_floor_and_advances(tmp_path):
    # A resumed run must continue its frame seq (not restart at 1), because the
    # frame table PK is (surface, run_id, seq) with INSERT OR IGNORE — a restarted
    # seq would be SILENTLY dropped as a duplicate.
    store = _store(tmp_path)
    assert store.max_frame_seq("chat", "chat_run_001") == 0  # no frames yet

    for seq in range(1, 6):
        store.append_frame("chat", "chat_run_001", seq, {"type": "text_delta", "seq": seq})
    assert store.max_frame_seq("chat", "chat_run_001") == 5

    # Resume: continue past the floor. A frame re-using an old seq is IGNORED
    # (dropped) — proving why the resume journal must start at floor+1.
    store.append_frame("chat", "chat_run_001", 3, {"type": "dup", "seq": 3})
    resume_start = store.max_frame_seq("chat", "chat_run_001") + 1
    assert resume_start == 6
    for seq in range(resume_start, resume_start + 3):
        store.append_frame("chat", "chat_run_001", seq, {"type": "done", "seq": seq})

    frames = store.list_frames("chat", "chat_run_001", from_seq=0)
    seqs = [frame["seq"] for frame in frames]
    assert seqs == [1, 2, 3, 4, 5, 6, 7, 8]  # strictly contiguous, the dup ignored
    assert frames[2]["type"] == "text_delta"  # seq 3 was NOT overwritten by the dup
    # Per-run scoping: a different run's seq space is independent.
    assert store.max_frame_seq("chat", "chat_run_999") == 0


def test_sweep_leaves_awaiting_continue_runs_untouched(tmp_path):
    # awaiting_continue is NON-terminal but a healthy, resumable rest — the startup
    # sweep must NOT heal it to interrupted (that would strand a continuable run).
    store = _store(tmp_path)
    assert "awaiting_continue" in RESUMABLE_RUN_STATUSES
    assert "awaiting_continue" not in TERMINAL_RUN_STATUSES
    _save(store, run_id="chat_run_paused", status="awaiting_continue")
    _save(store, run_id="chat_run_zombie", status="generating")

    healed = store.mark_stale_interrupted("chat")
    assert healed == 1  # only the true zombie
    assert store.get_run("chat", "chat_run_paused")["status"] == "awaiting_continue"
    assert store.get_run("chat", "chat_run_zombie")["status"] == "interrupted"
