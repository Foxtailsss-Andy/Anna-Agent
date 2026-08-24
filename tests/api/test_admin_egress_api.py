"""J4 · GET /api/admin/egress — the disclosure surface over HTTP.

``tests/gates/test_gate_egress.py`` pins the projection's content rules. This
module pins that the route actually exposes them on an unconfigured (default)
app: the endpoint exists, is shaped as the settings page expects, and — the part
only a route test can prove — an app with nothing wired discloses its full
surface area without inventing a destination or a probe result.

Two further route-only facts live here:

* the page about egress must not CAUSE egress — opening it fires zero connector
  probes;
* each row's destination comes from the adapter that actually owns it (a swap
  between two connectors is invisible to a single-settings test).
"""
import pytest
from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.hiker.app.orchestrator import HikerOrchestrator
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings


_EXPECTED_IDS = {"model_api", "reimbursement_mcp", "erp_mcp", "hiker_mcp"}


class _CountingAdapter:
    """An adapter whose ``status()`` is a NETWORK CALL — counted, never welcome.

    ``status()`` on every real connector gateway performs a ``tools/list``
    JSON-RPC round trip to the user's own server (30s timeout each). Counting the
    calls is how a test proves the disclosure route is a pure read.
    """

    def __init__(self, settings: RuntimeSettings) -> None:
        self.settings = settings
        self.probe_count = 0

    def status(self) -> dict:
        self.probe_count += 1
        return {"status": "connected", "server": "probed", "tool_count": 1}


def _app_with(reimb: _CountingAdapter, erp: _CountingAdapter, hiker: _CountingAdapter):
    return create_app(
        orchestrator=ReimbursementOrchestrator(adapter=reimb),
        associate_orchestrator=AssociateReceivablesOrchestrator(adapter=erp),
        hiker_orchestrator=HikerOrchestrator(adapter=hiker),
    )


def test_egress_endpoint_discloses_full_surface_on_an_unconfigured_app():
    client = TestClient(create_app())

    response = client.get("/api/admin/egress")

    assert response.status_code == 200
    body = response.json()
    items = body["destinations"]
    assert {item["id"] for item in items} == _EXPECTED_IDS

    for item in items:
        # Unwired app: listed, but nothing fabricated.
        assert item["configured"] is False
        assert item["destination"] is None
        assert item["last_probe_status"] is None
        assert item["label"]
        assert item["data_categories"]

    # The local-first claims travel as data, so the page renders facts not prose.
    assert body["telemetry"] is False
    assert body["training_feedback"] is False
    assert body["memory_location"] == "local"
    # v1 is disclosure only — the page says so rather than implying counters exist.
    assert body["counts_available"] is False
    assert body["disclosure_version"] == 1


def test_egress_endpoint_probes_nothing():
    """Opening the page about egress must not itself cause egress.

    The route used to fire three ``adapter.status()`` probes — and the settings
    page loads ``/api/admin/runtime/status`` alongside it, which fires the same
    three. Six outbound calls (sequential, 30s timeout each) to render a card
    whose entire claim is "we only talk to what you configured". The probe status
    the card shows is merged in the frontend from the status payload it already
    holds; this route stays a pure read of settings.
    """
    reimb = _CountingAdapter(RuntimeSettings(reimbursement_mcp_server="https://reimb.example/mcp"))
    erp = _CountingAdapter(RuntimeSettings(erp_mcp_server="https://erp.example/mcp"))
    hiker = _CountingAdapter(RuntimeSettings(hiker_mcp_server="https://hiker.example/mcp"))
    client = TestClient(_app_with(reimb, erp, hiker))

    response = client.get("/api/admin/egress")

    assert response.status_code == 200
    assert (reimb.probe_count, erp.probe_count, hiker.probe_count) == (0, 0, 0), (
        "the egress disclosure route probed the connectors — a page about egress "
        "must not be the thing that causes it"
    )
    # No probe ran, so no probe status is claimed (rather than a cheerful guess).
    for item in response.json()["destinations"]:
        assert item["last_probe_status"] is None


def test_egress_endpoint_survives_an_adapter_whose_probe_would_raise():
    """A dead connector cannot break the disclosure — because nothing is probed."""

    class _ExplodingAdapter(_CountingAdapter):
        def status(self) -> dict:
            self.probe_count += 1
            raise RuntimeError("connector unreachable")

    reimb = _ExplodingAdapter(RuntimeSettings(reimbursement_mcp_server="https://reimb.example/mcp"))
    erp = _ExplodingAdapter(RuntimeSettings(erp_mcp_server="https://erp.example/mcp"))
    hiker = _ExplodingAdapter(RuntimeSettings(hiker_mcp_server="https://hiker.example/mcp"))
    client = TestClient(_app_with(reimb, erp, hiker))

    response = client.get("/api/admin/egress")

    assert response.status_code == 200
    assert (reimb.probe_count, erp.probe_count, hiker.probe_count) == (0, 0, 0)


def test_egress_endpoint_reads_each_destination_from_its_own_adapter():
    """Every row's host comes from the adapter that owns it — no crossed wires.

    With one settings object behind all three connectors, an erp↔hiker swap in
    the route is invisible. Distinct per-adapter settings make the wiring itself
    assertable.
    """
    reimb = _CountingAdapter(
        RuntimeSettings(reimbursement_mcp_server="https://reimb-only.example/mcp")
    )
    erp = _CountingAdapter(RuntimeSettings(erp_mcp_server="https://erp-only.example/rpc"))
    hiker = _CountingAdapter(RuntimeSettings(hiker_mcp_server="https://hiker-only.example/h"))
    client = TestClient(_app_with(reimb, erp, hiker))

    body = client.get("/api/admin/egress").json()
    by_id = {item["id"]: item for item in body["destinations"]}

    assert by_id["reimbursement_mcp"]["destination"] == "https://reimb-only.example/mcp"
    assert by_id["erp_mcp"]["destination"] == "https://erp-only.example/rpc"
    assert by_id["hiker_mcp"]["destination"] == "https://hiker-only.example/h"


@pytest.mark.parametrize("field", ["telemetry", "training_feedback", "memory_location"])
def test_egress_endpoint_always_carries_the_honesty_fields(field: str):
    """The three standing claims are DATA on every response — the card renders them.

    The settings page used to print them as hardcoded prose, which meant the card
    kept promising "无遥测" even if the backend ever said otherwise.
    """
    body = TestClient(create_app()).get("/api/admin/egress").json()

    assert field in body
