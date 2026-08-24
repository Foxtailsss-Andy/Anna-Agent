import threading

from services.runtime.app.run_registry import RunRegistry


def test_next_id_is_prefixed_and_zero_padded():
    registry: RunRegistry[str] = RunRegistry("finance_run_")
    assert registry.next_id() == "finance_run_001"
    assert registry.next_id() == "finance_run_002"


def test_put_get_values_roundtrip():
    registry: RunRegistry[str] = RunRegistry("r_")
    registry.put("r_001", "alpha")
    registry.put("r_002", "beta")
    assert registry.get("r_001") == "alpha"
    assert registry.get("missing") is None
    assert registry.values() == ["alpha", "beta"]


def test_storage_is_bounded_and_evicts_oldest():
    registry: RunRegistry[int] = RunRegistry("r_", max_runs=2)
    registry.put("r_001", 1)
    registry.put("r_002", 2)
    registry.put("r_003", 3)
    assert registry.get("r_001") is None  # evicted (oldest)
    assert registry.values() == [2, 3]


def test_re_put_updates_lru_order():
    registry: RunRegistry[int] = RunRegistry("r_", max_runs=2)
    registry.put("r_001", 1)
    registry.put("r_002", 2)
    registry.put("r_001", 99)   # touch r_001 — it moves to the recent end
    registry.put("r_003", 3)    # should evict r_002 (now oldest), not r_001
    assert registry.get("r_002") is None  # evicted
    assert registry.get("r_001") == 99    # still present, updated value
    assert registry.get("r_003") == 3


def test_concurrent_next_id_never_collides():
    registry: RunRegistry[str] = RunRegistry("c_")
    ids: list[str] = []
    lock = threading.Lock()

    def worker() -> None:
        for _ in range(50):
            run_id = registry.next_id()
            with lock:
                ids.append(run_id)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(ids) == 400
    assert len(set(ids)) == 400  # all unique despite concurrency


def test_max_runs_below_one_is_rejected():
    import pytest

    with pytest.raises(ValueError):
        RunRegistry("r_", max_runs=0)
    with pytest.raises(ValueError):
        RunRegistry("r_", max_runs=-1)
