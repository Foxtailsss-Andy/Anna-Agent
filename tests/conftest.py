"""Shared test fixtures (repo root ``tests/``)."""
from __future__ import annotations

import pytest

from services.runtime.app.autocompact import reset_autocompact_trackers
from services.runtime.app.concurrency import reset_shared_model_call_buckets
from services.runtime.app.interjections import reset_interjections


@pytest.fixture(autouse=True)
def _fresh_shared_model_call_buckets():
    """Reset the process-wide model-call bucket registry around every test (L5).

    The bucket is process-global BY DESIGN (one rate gate for the whole app), so
    without a per-test reset every test driving the REAL model chokepoints
    (``stream_model`` / ``call_model`` / the autocompact summary) would drain one
    shared 30-token burst and late tests could start rate-DELAYING for real.
    A fresh bucket per test keeps the default effectively unlimited (no single
    test makes 30 model calls in a minute) unless a test installs a tight bucket
    itself — exactly the production semantics, without cross-test coupling.
    """
    reset_shared_model_call_buckets()
    yield
    reset_shared_model_call_buckets()


@pytest.fixture(autouse=True)
def _fresh_autocompact_trackers():
    """Reset the process-wide autocompact tracker cache around every test (L4a).

    The per-run circuit-breaker tracker cache is process-global BY DESIGN (keyed
    by run_id across a run's successive model calls), so without a per-test reset
    a tracker left over from one test — or a run_id collision — could leak a spent
    circuit breaker into another test's autocompact path. Mirrors the shared
    bucket reset above: fresh state per test, no cross-test coupling.
    """
    reset_autocompact_trackers()
    yield
    reset_autocompact_trackers()


@pytest.fixture(autouse=True)
def _fresh_interjection_queues():
    """Reset the process-wide interjection queue registry around every test (J3).

    ``interjections._queues`` is module-level BY DESIGN (the HTTP producer and
    the engine-side consumer never see each other, so they meet in one run_id
    keyed registry — the same shape as the autocompact trackers above). Without a
    per-test reset, a queue a test leaves behind — or a run_id collision — leaks
    a phantom user turn into a later test's model request, since the engine
    drains the queue at the TOP of every turn. Fresh state per test, no
    cross-test coupling.
    """
    reset_interjections()
    yield
    reset_interjections()
