"""Egress disclosure — where your data goes, as a checkable fact (J4 v1).

Anna is local-first: the model API and configured MCP connectors are the ONLY
places data ever leaves for, and every one of them is an endpoint the user
configured themselves. This projection states that in a form the settings page
can render and a test can assert, instead of leaving it as a claim in a README.

Three disciplines, all load-bearing:

* **Exhaustive, not selective.** Every destination Anna is CAPABLE of reaching
  is listed, wired or not. Hiding the unconfigured ones would understate the
  surface area — the honest answer to "where could my data go?" includes the
  connectors you have not turned on yet. It also includes every model PROFILE
  that carries its own endpoint: those are one click away at send time, so a
  card that showed only ``model_endpoint`` would claim an exclusivity the
  runtime does not have.
* **Never invent.** An unconfigured destination reports ``configured: False``
  with ``destination: None`` and ``last_probe_status: None``. No placeholder
  host, no probe status for a probe that never ran, and no row at all for a
  profile with no endpoint to resolve.
* **Static read, zero side effects.** The projection itself performs NO I/O: it
  reads loaded settings and whatever probe results the caller injects. The route
  injects NOTHING — it merges the probe status the settings page already holds
  from ``/api/admin/runtime/status`` instead, so the page about egress can never
  be the thing that causes it. The parameter stays because the projection is
  pure and the gate exercises it both ways.

v1 is pure disclosure: what the destinations are and what category of data each
one receives. Per-destination counters and payload redaction are later slices;
listing them here as "coming" rather than shipping half of them keeps the page
honest about its own scope.

The zero-egress claim behind ``telemetry`` / ``training_feedback`` is not a
constant anyone can flip by hand — ``tests/gates/test_gate_egress.py`` scans
every module under ``services/`` (plus the Electron main and the ops scripts)
for hardcoded remote endpoints, so the field stays true by construction.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from ..redaction import _redact_runtime_text


# What each destination receives, in plain language. Understating any of these
# is the same failure as hiding a destination outright: the user reads the card,
# believes it, and is wrong about their own data.
MODEL_DATA_CATEGORIES = ["对话内容", "工具调用结果", "技能提示词"]
# ``materialize_attachments_for_mcp`` base64-encodes the ENTIRE attachment file
# into the draft payload (``content_base64``) — a scanned invoice or a PDF leaves
# the machine in full, which "报销单字段" alone would badly understate.
REIMBURSEMENT_DATA_CATEGORIES = ["报销单字段", "附件原文（图片、PDF 全文）"]
ERP_DATA_CATEGORIES = ["查询参数", "催收任务草稿字段（摘要、期间、审批凭证）"]
HIKER_DATA_CATEGORIES = ["查询参数"]


def _destination(raw: str | None) -> str | None:
    """The configured endpoint, safe to display — or None when unconfigured.

    Rebuilt as ``scheme://host[:port]/path`` and nothing else. A query string is
    never part of the answer to "where does my data go", and it is exactly where
    a credential hides that the shared redactor does not know by name (``?key=``
    is not in its vocabulary, so redaction alone would print the secret).
    Userinfo goes the same way — dropping both STRUCTURALLY beats matching them
    by pattern.

    The host itself is deliberately NOT masked: naming the real destination is
    the entire purpose of this disclosure.

    Order note: the shared redactor runs on the REBUILT value, not before the
    parse. Its userinfo rule rewrites ``user:tok@host`` to ``[redacted]@host``,
    and those square brackets make ``urlsplit`` reject the URL as a malformed
    IPv6 literal — redacting first would have turned every credential-bearing
    endpoint into "unparseable". It still runs (belt-and-braces for a secret
    hiding in a path segment), and it still runs on the non-URL fallback below.
    """
    if raw is None:
        return None
    trimmed = str(raw).strip()
    if not trimmed:
        return None
    try:
        parts = urlsplit(trimmed)
        hostname, port = parts.hostname, parts.port
    except ValueError:
        # Not parseable as a URL — fall back to the redacted raw text rather
        # than dropping a destination the user really did configure.
        return _redact_runtime_text(trimmed)
    if not parts.scheme or not hostname:
        # Not a URL (a bare host, a socket path…). Nothing to strip structurally,
        # and nothing to invent either — show it redacted, verbatim.
        return _redact_runtime_text(trimmed)
    netloc = hostname if port is None else f"{hostname}:{port}"
    return _redact_runtime_text(f"{parts.scheme}://{netloc}{parts.path}")


def _model_profile_rows(
    settings: Any,
    default_endpoint: str | None,
) -> list[dict[str, Any]]:
    """One row per model profile that resolves to a DIFFERENT endpoint.

    ``RuntimeSettings.resolve_model_profile`` is what a chat run calls before the
    request leaves, and it falls the endpoint back to the default — so a profile
    without its own endpoint is not a new destination and must not get a second
    row (an overstated surface area is as misleading as a hidden one). A profile
    that resolves to no endpoint at all gets nothing: there is no destination to
    disclose and none will be invented.
    """
    profiles = getattr(settings, "model_profiles", ()) or ()
    resolve = getattr(settings, "resolve_model_profile", None)
    if not callable(resolve):
        return []
    rows: list[dict[str, Any]] = []
    seen: set[str] = {default_endpoint} if default_endpoint else set()
    for raw in profiles:
        if not isinstance(raw, dict):
            continue
        profile_id = str(raw.get("id") or "").strip()
        if not profile_id or profile_id == "default":
            continue
        try:
            resolved = resolve(profile_id)
        except Exception:  # noqa: BLE001 — an unresolvable profile discloses nothing
            continue
        endpoint = _destination(getattr(resolved, "model_endpoint", None))
        if endpoint is None or endpoint in seen:
            continue
        seen.add(endpoint)
        # Same pair as the default row: an endpoint with no key never leaves.
        configured = bool(getattr(resolved, "model_api_key", None))
        label = str(raw.get("label") or raw.get("model_name") or profile_id)
        rows.append(
            {
                "id": f"model_api:{profile_id}",
                "label": f"模型 API·{label}",
                "destination": endpoint if configured else None,
                "data_categories": list(MODEL_DATA_CATEGORIES),
                "configured": configured,
                # No connector probes a model endpoint — claiming a status here
                # would be inventing one.
                "last_probe_status": None,
            }
        )
    return rows


def egress_projection(
    settings: Any,
    *,
    probe_status: dict[str, str] | None = None,
    mcp_settings: Any = None,
    erp_settings: Any = None,
    hiker_settings: Any = None,
) -> dict[str, Any]:
    """Build the egress disclosure from loaded settings + collected probe status.

    ``settings`` carries the model configuration. Each connector may be
    configured from its OWN settings object (the adapters load independently —
    see ``_runtime_config_status``), so the route passes them explicitly; each
    falls back to ``settings`` when omitted, which is what a single-settings
    caller (and the gate) wants.

    ``probe_status`` maps a destination id to the status its LAST connector probe
    reported. A destination absent from the mapping — or unconfigured — reports
    ``None`` rather than a guess. The HTTP route deliberately passes nothing (it
    probes nothing); the frontend merges the status it already holds.
    """
    probes = probe_status or {}
    mcp_src = mcp_settings if mcp_settings is not None else settings
    erp_src = erp_settings if erp_settings is not None else settings
    hiker_src = hiker_settings if hiker_settings is not None else settings

    def probe_for(key: str, configured: bool) -> str | None:
        if not configured:
            # Nothing was ever probed, so there is nothing to report. Reporting
            # "disconnected" here would read as a failed connection attempt.
            return None
        status = probes.get(key)
        return str(status) if status else None

    model_endpoint = _destination(getattr(settings, "model_endpoint", None))
    # The model call needs BOTH an endpoint and a key to ever leave the machine,
    # which is the same pair ``_model_status`` treats as configured.
    model_configured = bool(model_endpoint and getattr(settings, "model_api_key", None))
    reimbursement = _destination(getattr(mcp_src, "reimbursement_mcp_server", None))
    erp = _destination(getattr(erp_src, "erp_mcp_server", None))
    hiker = _destination(getattr(hiker_src, "hiker_mcp_server", None))

    destinations: list[dict[str, Any]] = [
        {
            "id": "model_api",
            "label": "模型 API",
            "destination": model_endpoint if model_configured else None,
            "data_categories": list(MODEL_DATA_CATEGORIES),
            "configured": model_configured,
            "last_probe_status": probe_for("model_api", model_configured),
        },
        *_model_profile_rows(settings, model_endpoint),
        {
            "id": "reimbursement_mcp",
            "label": "报销 MCP",
            "destination": reimbursement,
            "data_categories": list(REIMBURSEMENT_DATA_CATEGORIES),
            "configured": reimbursement is not None,
            "last_probe_status": probe_for("reimbursement_mcp", reimbursement is not None),
        },
        {
            "id": "erp_mcp",
            "label": "ERP MCP",
            "destination": erp,
            "data_categories": list(ERP_DATA_CATEGORIES),
            "configured": erp is not None,
            "last_probe_status": probe_for("erp_mcp", erp is not None),
        },
        {
            "id": "hiker_mcp",
            "label": "Hiker MCP",
            "destination": hiker,
            "data_categories": list(HIKER_DATA_CATEGORIES),
            "configured": hiker is not None,
            "last_probe_status": probe_for("hiker_mcp", hiker is not None),
        },
    ]

    return {
        "destinations": destinations,
        # Standing claims of a local-first runtime, as fields rather than prose
        # so the frontend renders data and the gate can assert them.
        "telemetry": False,
        "training_feedback": False,
        "memory_location": "local",
        # v1 scope, stated on the page itself rather than silently implied.
        "disclosure_version": 1,
        "counts_available": False,
    }
