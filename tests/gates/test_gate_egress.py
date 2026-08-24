"""J4 · Egress 出境披露 v1 gate (eval-first, the RED).

A code-judged gate for the Judgment round, slice J4: an enterprise AIOS must be
able to answer "where does my data go?" with something better than a promise.
Anna is local-first, so the honest answer is short — and this gate makes it
*checkable* rather than marketing copy. It is the executable acceptance
criterion the implementation must turn green — written and committed BEFORE any
production change.

Three scenarios:

* Scenario A — the disclosure is COMPLETE: every external destination Anna can
  reach (the model API + the three MCP connectors) appears, each carrying
  ``destination`` / ``data_categories`` / ``configured`` / ``last_probe_status``.
  What is configured shows its real host, so the page states a fact rather than
  a category. "Complete" includes the model profiles the user can SELECT at
  send time: a profile carrying its own endpoint is a second host, and a card
  that omits it is claiming an exclusivity it does not have.
* Scenario B — the disclosure never INVENTS: with nothing configured, every
  entry is still listed (the surface area is the truth, not the subset that
  happens to be wired) but ``configured`` is false and ``destination`` is None —
  no placeholder host, no probe status pretending a connection was tried.
  Secrets never appear in a destination — including the ones that ride in a
  URL's query string or userinfo, which is why the displayed destination is
  rebuilt from scheme+host+path and nothing else.
* Scenario C — the ZERO-EGRESS lock (the regression door): a source scan asserts
  that NO module under ``services/`` — and no script under ``scripts/`` or
  ``apps/desktop/electron/`` — contains a hardcoded remote endpoint. Every
  outbound destination must come from user configuration, so a telemetry ping,
  an analytics beacon or a "just this once" upload added later cannot land
  silently — it has to walk past this test first.

This gate must stay green in every later slice.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from urllib.parse import urlparse

from services.api.app.projections.egress import egress_projection
from services.runtime.app.config import RuntimeSettings


_REQUIRED_KEYS = {
    "id",
    "label",
    "destination",
    "data_categories",
    "configured",
    "last_probe_status",
}

# Every external destination Anna is capable of reaching. Adding a connector
# without adding it here (and to the projection) fails Scenario A — the
# disclosure is only trustworthy if it is exhaustive.
_EXPECTED_IDS = {"model_api", "reimbursement_mcp", "erp_mcp", "hiker_mcp"}

_ALL_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key-secret",
    reimbursement_mcp_server="https://reimb.example/mcp",
    reimbursement_mcp_api_key="reimb-key-secret",
    erp_mcp_server="https://erp.example/mcp",
    hiker_mcp_server="https://hiker.example/mcp",
    hiker_mcp_api_key="hiker-key-secret",
)

_NOTHING_CONFIGURED = RuntimeSettings()


def test_gate_egress_discloses_every_configured_destination():
    """Scenario A — complete, concrete, and honest about what each one receives."""
    projection = egress_projection(
        _ALL_CONFIGURED,
        probe_status={
            "reimbursement_mcp": "connected",
            "erp_mcp": "connected",
            "hiker_mcp": "error",
        },
    )
    items = projection["destinations"]
    assert {item["id"] for item in items} == _EXPECTED_IDS

    for item in items:
        assert _REQUIRED_KEYS <= set(item)
        assert item["configured"] is True
        # A real host, not a category — this is the whole point of the page.
        assert item["destination"]
        assert urlparse(item["destination"]).hostname
        # What actually leaves for this destination, stated in plain language.
        assert item["data_categories"]
        assert all(isinstance(c, str) and c for c in item["data_categories"])

    # No secret ever rides along in a disclosed destination.
    blob = " ".join(str(item["destination"]) for item in items)
    for secret in ("model-key-secret", "reimb-key-secret", "hiker-key-secret"):
        assert secret not in blob

    # Probe status is reported as observed — including the unhappy one.
    by_id = {item["id"]: item for item in items}
    assert by_id["erp_mcp"]["last_probe_status"] == "connected"
    assert by_id["hiker_mcp"]["last_probe_status"] == "error"

    # The standing claims of a local-first runtime, as machine-checkable fields.
    assert projection["telemetry"] is False
    assert projection["training_feedback"] is False
    assert projection["memory_location"] == "local"


def test_gate_egress_discloses_the_endpoint_of_every_selectable_model_profile():
    """A profile the user can pick is a destination — its host must be on the card.

    ``RuntimeSettings.model_profiles`` lets each profile carry its OWN endpoint,
    and ``resolve_model_profile`` is what a chat run calls before the request
    leaves. A card that only shows ``model_endpoint`` therefore states "we only
    send to the following endpoints" while a one-click selection sends elsewhere.

    Two halves, both load-bearing: the profile with its own host gets a row, and
    the profile WITHOUT one does not — its endpoint falls back to the default,
    and a duplicate row would overstate the surface area just as badly as the
    omission understates it.
    """
    settings = RuntimeSettings(
        model_endpoint="https://model.example/v1/chat/completions",
        model_api_key="model-key-secret",
        model_profiles=(
            {
                "id": "azure",
                "label": "Azure 东南亚",
                "endpoint": "https://other.example/v1",
                "api_key": "azure-key-secret",
            },
            # Same host as the default (no endpoint of its own) — NOT a new
            # destination, so it must not add a row.
            {"id": "cheap", "label": "省钱档", "model_name": "small"},
        ),
    )

    projection = egress_projection(settings)
    items = projection["destinations"]
    by_id = {item["id"]: item for item in items}

    assert "model_api:azure" in by_id, (
        "a selectable profile pointing at another host is not disclosed — "
        f"rows: {sorted(by_id)}"
    )
    azure = by_id["model_api:azure"]
    assert _REQUIRED_KEYS <= set(azure)
    assert azure["destination"] == "https://other.example/v1"
    assert azure["configured"] is True
    assert "Azure 东南亚" in azure["label"]
    assert azure["data_categories"]
    # The default row stays exactly what it was.
    assert by_id["model_api"]["destination"] == "https://model.example/v1/chat/completions"
    # A profile without its own endpoint resolves to the default host — one row,
    # not two.
    assert "model_api:cheap" not in by_id
    endpoints = [item["destination"] for item in items if item["destination"]]
    assert len(endpoints) == len(set(endpoints)), f"duplicate destination rows: {endpoints}"
    # Nothing invented, and no key ever rides along.
    assert "azure-key-secret" not in str(projection)


def test_gate_egress_never_invents_a_profile_endpoint():
    """A profile with no resolvable endpoint gets no row — not a placeholder one."""
    settings = RuntimeSettings(
        model_profiles=(
            {"id": "ghost", "label": "无端点", "model_name": "x"},
            {"id": "", "label": "无 id"},
        ),
    )

    items = egress_projection(settings)["destinations"]

    assert {item["id"] for item in items} == _EXPECTED_IDS
    for item in items:
        assert item["destination"] is None


def test_gate_egress_never_invents_an_unconfigured_destination():
    """Scenario B — nothing configured: still listed, but nothing is fabricated."""
    projection = egress_projection(_NOTHING_CONFIGURED)
    items = projection["destinations"]
    # The full surface area is disclosed even when unwired — hiding the
    # unconfigured ones would understate where data COULD go.
    assert {item["id"] for item in items} == _EXPECTED_IDS

    for item in items:
        assert item["configured"] is False
        assert item["destination"] is None  # no placeholder host
        assert item["last_probe_status"] is None  # nothing was ever probed
        # The categories still describe what WOULD be sent if it were wired.
        assert item["data_categories"]

    assert projection["telemetry"] is False
    assert projection["training_feedback"] is False
    assert projection["memory_location"] == "local"


def test_gate_egress_destination_drops_query_and_userinfo():
    """Scenario B (secrets) — the destination is *where*, never *with what*.

    A query string is not part of "where does my data go", and it is where a
    credential most often hides (``?key=…`` is not in the redactor's named-key
    vocabulary, so redaction alone leaks it). Userinfo is the same story. Both
    are dropped outright: scheme + host [+ port] + path, nothing else.
    """
    settings = RuntimeSettings(
        reimbursement_mcp_server="https://user:tok@mcp.example/mcp?key=SECRET",
        erp_mcp_server="https://erp.example:8443/rpc?token=ANOTHER-SECRET#frag",
    )

    projection = egress_projection(settings)
    by_id = {item["id"]: item for item in projection["destinations"]}

    assert by_id["reimbursement_mcp"]["destination"] == "https://mcp.example/mcp"
    assert by_id["erp_mcp"]["destination"] == "https://erp.example:8443/rpc"
    blob = str(projection)
    assert "SECRET" not in blob
    assert "tok@" not in blob


def test_gate_egress_reimbursement_category_names_the_attachment_bytes():
    """报销 MCP receives whole files — the card must say so.

    ``materialize_attachments_for_mcp`` base64-encodes the ENTIRE attachment and
    ships it in the draft payload (``content_base64``). "报销单字段" reads as a
    handful of form values; a scanned invoice or a PDF leaving the machine is a
    different order of disclosure and has to be stated.
    """
    items = egress_projection(_ALL_CONFIGURED)["destinations"]
    by_id = {item["id"]: item for item in items}

    categories = by_id["reimbursement_mcp"]["data_categories"]
    assert any("附件" in c for c in categories), categories
    # ERP receives collection-task DRAFT fields on the approved write path
    # (``erp.collection_task.create_draft``), not just query parameters.
    erp_categories = by_id["erp_mcp"]["data_categories"]
    assert any("草稿" in c for c in erp_categories), erp_categories


# --- Scenario C · the zero-egress lock ------------------------------------

# A URL literal, extracted from LOWERCASED source text. Lowercasing first is what
# makes the scan case-blind ("HTTPS://EVIL.EXAMPLE" is the same egress as the
# lowercase one, and a case-sensitive match is a one-keystroke evasion).
_URL_LITERAL = re.compile(r"https?://[^\s\"'<>)]+")

# Loopback is not egress: dev CORS origins, the local ERP sidecar, the packaged
# runtime's own uvicorn bind.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}


def _remote_urls(text: str) -> list[str]:
    """Every REMOTE URL literal inside one blob of source text.

    Deliberately NOT ``str.split()``: a URL is not required to be whitespace
    delimited (``"upload:https://host/x"`` is one token and used to slip past),
    so the extraction is a regex over the whole lowercased blob.

    Three things are not offenders:

    * a loopback host (see ``_LOOPBACK_HOSTS``);
    * a scheme-only literal — ``"https://"`` concatenated with a configured
      host at runtime parses to an EMPTY hostname, which is the honest reading:
      there is no hardcoded destination in the source;
    * a host that is a template placeholder (``https://${API_HOST}:…``) — the
      host comes from a variable, so this scan cannot judge it (see the
      coverage note in the test docstring).
    """
    found: list[str] = []
    for match in _URL_LITERAL.finditer(text.lower()):
        url = match.group(0)
        try:
            host = urlparse(url).hostname or ""
        except ValueError:
            # An unparseable URL literal deserves human eyes rather than a pass.
            found.append(url)
            continue
        if not host or host in _LOOPBACK_HOSTS:
            continue
        if host.startswith("${"):
            continue
        found.append(url)
    return found


def test_gate_egress_url_scanner_catches_the_known_evasions():
    """The scanner itself, pinned against synthetic sources (no offender in tree).

    Every case below is one an earlier version of this gate let through. They are
    asserted against the helper directly so the lock is verified without planting
    a real remote endpoint in the repository.
    """
    # Case-blind: uppercase is the same egress.
    assert _remote_urls("HTTPS://EVIL.EXAMPLE/beacon") == ["https://evil.example/beacon"]
    # Not whitespace delimited.
    assert _remote_urls("upload:https://evil.example/x") == ["https://evil.example/x"]
    # Embedded in a longer sentence, punctuation-terminated.
    assert _remote_urls("post to https://evil.example/x, then stop") == [
        "https://evil.example/x,"
    ]
    # Benign classes stay benign.
    assert _remote_urls("http://127.0.0.1:8000/api") == []
    assert _remote_urls("https://") == []  # scheme-only + runtime-configured host
    assert _remote_urls("base = `http://${API_HOST}:${PORT}`") == []
    assert _remote_urls("no url here at all") == []


def _scannable_text(path: Path) -> str:
    """All STRING/BYTES literal text of a Python module, as one blob.

    AST-scoped on purpose: a URL in a ``#`` comment cannot send anything, while a
    bytes literal (``b"https://…"``) very much can — and the previous version of
    this gate walked past bytes constants entirely.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    chunks: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant):
            continue
        if isinstance(node.value, str):
            chunks.append(node.value)
        elif isinstance(node.value, bytes):
            # latin-1 never raises and preserves every byte 1:1 — good enough to
            # find an ASCII URL inside an otherwise binary literal.
            chunks.append(node.value.decode("latin-1"))
    return "\n".join(chunks)


def test_gate_egress_no_hardcoded_remote_endpoint_in_services():
    """Scenario C — the zero-egress lock: every destination comes from config.

    Scans every module under ``services/`` (string AND bytes literals) plus every
    script under ``scripts/`` and ``apps/desktop/electron/`` (textually — the
    Electron main process and the ops scripts run outside Python and could ship a
    beacon just as easily). A loopback address is fine; ANY remote host hardcoded
    in source is a destination the user never configured and cannot see on the
    disclosure page — exactly the failure mode this slice exists to make
    impossible.

    **What this gate does NOT cover** (stated so nobody reads it as more than it
    is):

    * hosts supplied by configuration — that is the DESIGN, and the disclosure
      page is what makes them visible;
    * URLs built by string concatenation or ``%``/``format`` interpolation whose
      host is a variable — e.g. ``f"https://{host}/x"`` reads here as a
      scheme-only literal;
    * template-literal hosts in JS (``` `http://${API_HOST}:${PORT}` ```) — the
      two in the tree today resolve to loopback constants declared in the same
      file (``apps/desktop/electron/runtime-service.mjs``,
      ``scripts/live-crew-e2e.mjs``) and were hand-verified;
    * anything constructed at RUNTIME from data (a model-authored URL, a tool
      argument) — that is the sandbox/permission layer's job, not a source scan;
    * ``vendor/`` (third-party reference sources, not shipped in Anna's request
      path) and the test tree itself.
    """
    repo_root = Path(__file__).resolve().parents[2]
    services_root = repo_root / "services"
    assert services_root.is_dir()

    offenders: list[str] = []
    unscannable: list[str] = []

    for path in sorted(services_root.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            blob = _scannable_text(path)
        except (OSError, UnicodeDecodeError, SyntaxError, ValueError) as exc:
            unscannable.append(f"{path}: {type(exc).__name__}: {exc}")
            continue
        offenders.extend(f"{path}: {url}" for url in _remote_urls(blob))

    js_roots = [repo_root / "apps" / "desktop" / "electron", repo_root / "scripts"]
    for root in js_roots:
        assert root.is_dir(), f"scan scope moved: {root} is gone — fix the gate"
        for path in sorted(root.rglob("*")):
            if path.suffix not in {".mjs", ".js", ".cjs", ".ps1"} or not path.is_file():
                continue
            try:
                blob = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                unscannable.append(f"{path}: {type(exc).__name__}: {exc}")
                continue
            offenders.extend(f"{path}: {url}" for url in _remote_urls(blob))

    assert unscannable == [], (
        "the zero-egress scan could not read these files, so it proves NOTHING "
        "about them — fix the file (or the scanner) rather than trusting a "
        "silently skipped module:\n" + "\n".join(unscannable)
    )
    assert offenders == [], (
        "hardcoded remote endpoint(s) found — every outbound destination must "
        "come from user configuration and be disclosed:\n" + "\n".join(offenders)
    )
