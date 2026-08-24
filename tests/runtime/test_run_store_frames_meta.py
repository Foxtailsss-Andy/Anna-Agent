"""list_frames_with_meta —— Trace 轮 T1 的读取面：帧 + 行级 created_at。"""
from services.runtime.app.run_store import SQLiteRunStore


def test_list_frames_with_meta_returns_frame_and_created_at(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs.db")
    store.append_frame("chat", "r1", 1, {"type": "tool_start", "name": "erp.finance.query", "seq": 1})
    store.append_frame("chat", "r1", 2, {"type": "tool_done", "name": "erp.finance.query", "seq": 2})
    rows = store.list_frames_with_meta("chat", "r1")
    assert [r["frame"]["seq"] for r in rows] == [1, 2]
    assert all(isinstance(r["created_at"], str) and r["created_at"] for r in rows)


def test_list_frames_with_meta_skips_corrupt_rows(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs.db")
    store.append_frame("chat", "r1", 1, {"type": "done", "seq": 1})
    with store._connect() as conn:  # 与 list_frames 的坏行纪律同源:直接塞坏 JSON
        conn.execute(
            "INSERT INTO run_frames (surface, run_id, seq, frame, created_at) VALUES ('chat','r1',2,'{broken', datetime('now'))"
        )
    rows = store.list_frames_with_meta("chat", "r1")
    assert [r["frame"]["seq"] for r in rows] == [1]
