"""B3 · 报销流程投影 (read-only).

Projects reimbursement runs — owned ENTIRELY by ``services/reimbursement`` — onto
a 4-step Crew stepper for the inbox「等我审」lane and ``GET /api/crew/approvals``.
This module only READS the reimbursement state store; it writes NOTHING back to
reimbursement (no code there is touched or imported for mutation).

真实状态字段 → 四步映射
======================
Source fields (services/reimbursement/app/schemas.py):
  · ``ReimbursementRun.status``            (RunStatus)
  · ``ReimbursementRun.approval.status``   (pending|approved|rejected|expired)
  · ``ReimbursementRun.write_action.verify_status`` (verified|verify_pending|failed)
  · ``ReimbursementRun.draft.external_reimbursement_id`` (set ⇒ external draft exists)

  RunStatus            approval        write_action        → step
  -----------------    ------------    ----------------    ------------------
  validating           —               —                   submitted
  collecting           —               —                   submitted
  draft_created        none/rejected   —                   drafted
  waiting_confirmation pending         —                   awaiting_approval  ← actionable
  submitting           approved        —                   drafted*
  verifying            approved        —                   drafted*
  verify_pending       approved        verify_pending      drafted*
  completed            approved        verified            verified
  failed               (any)           (any)               — (excluded)

  * post-approval in-flight / not-yet-read-back states: an external draft exists
    but the write is not confirmed verified — projected honestly as ``drafted``
    (never falsely ``verified``). ``failed`` runs are excluded: the 4-step model
    has no failure step, and forcing one would fabricate progress (零捏造).

The step is computed by「furthest confirmed milestone」precedence
(verified > awaiting_approval > drafted > submitted), so the derivation stays
robust to the exact transient status the run happens to be persisted in.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from typing import Any

from services.reimbursement.app.schemas import ReimbursementRun

logger = logging.getLogger(__name__)

# Short backoff before retrying a transient read failure (e.g. a briefly locked
# DB). Kept tiny so a live inbox/approvals read never stalls noticeably.
_RETRY_WAIT_S = 0.05


def _read_run_payloads(db_path: str) -> list[str]:
    """Read every reimbursement run's raw JSON payload (READ-ONLY, newest first).

    Isolated as a module-level function so ``load_workspace_runs`` can classify /
    retry the ``sqlite3.OperationalError`` it may raise (and so tests can inject a
    controlled error sequence)."""
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            "SELECT payload FROM reimbursement_runs ORDER BY rowid DESC"
        ).fetchall()
    finally:
        connection.close()
    return [row["payload"] for row in rows]


# The four projected steps, in forward order (a stepper renders progress up to
# the current one). ``awaiting_approval`` is the only Boss-actionable step.
STEP_SUBMITTED = "submitted"
STEP_DRAFTED = "drafted"
STEP_AWAITING_APPROVAL = "awaiting_approval"
STEP_VERIFIED = "verified"


def project_step(run: ReimbursementRun) -> str | None:
    """Map one run onto its 4-step milestone, or ``None`` to exclude it.

    Precedence = furthest confirmed milestone (see module docstring)."""
    if run.status == "failed":
        return None  # no failure step in the 4-step model — exclude, never fake
    if run.status == "completed" or (
        run.write_action is not None and run.write_action.verify_status == "verified"
    ):
        return STEP_VERIFIED
    if run.approval is not None and run.approval.status == "pending":
        return STEP_AWAITING_APPROVAL
    if run.draft.external_reimbursement_id:
        return STEP_DRAFTED
    return STEP_SUBMITTED


def _updated_at(run: ReimbursementRun) -> str | None:
    """Best-available last-activity time: the newest audit event's timestamp."""
    if run.audit_events:
        return run.audit_events[-1].created_at
    return None


def project_run(run: ReimbursementRun) -> dict[str, Any] | None:
    """One projection card, or ``None`` when the run has no meaningful step."""
    step = project_step(run)
    if step is None:
        return None
    return {
        "run_id": run.id,
        "applicant": run.actor_user_id,
        "amount": run.draft.amount,
        "currency": run.draft.currency,
        "step": step,
        "deep_link": f"/cowork/reimbursements/runs/{run.id}",
        "updated_at": _updated_at(run),
        # Carried for the inbox「去审批」action; the frontend calls the
        # reimbursement approve endpoint with it. None until an approval exists.
        "approval_id": run.approval.id if run.approval is not None else None,
    }


def project_runs(runs: list[ReimbursementRun]) -> list[dict[str, Any]]:
    """Project a list of runs, dropping excluded ones, newest activity first."""
    cards = [card for card in (project_run(run) for run in runs) if card is not None]
    cards.sort(key=lambda card: card.get("updated_at") or "", reverse=True)
    return cards


def load_workspace_runs(reimbursement: Any, workspace_id: str) -> list[ReimbursementRun]:
    """Read every reimbursement run in a workspace (cross-actor), READ-ONLY.

    The Boss's approval projection must see the whole team's runs, but the
    reimbursement store's public ``list_runs`` is per-actor. So we read the same
    ``reimbursement_runs`` table read-only via its own db path (a public
    attribute), parse each payload with the domain's own model, and filter by
    workspace — zero reimbursement code touched, zero writes.

    Falls back to the orchestrator's in-memory run map when no state store is
    wired (in-memory-only runs, e.g. some tests)."""
    store = getattr(reimbursement, "state_store", None)
    db_path = getattr(store, "db_path", None) if store is not None else None
    if db_path is not None:
        try:
            payloads = _read_run_payloads(db_path)
        except sqlite3.OperationalError as exc:
            if "no such table" in str(exc).lower():
                # Table not created yet (no reimbursement activity) — the honest
                # empty case; not a failure, so no retry and no warning.
                return []
            # A transient error (e.g. "database is locked") — retry once after a
            # short wait. If it STILL fails we return [] (the inbox must not break)
            # but log at WARNING so a genuinely new failure mode is surfaced, never
            # silently masqueraded as "no activity".
            logger.warning(
                "reimbursement projection read failed (%s); retrying once", exc
            )
            time.sleep(_RETRY_WAIT_S)
            try:
                payloads = _read_run_payloads(db_path)
            except sqlite3.OperationalError:
                logger.warning(
                    "reimbursement projection read still failing after retry; "
                    "returning empty projection",
                    exc_info=True,
                )
                return []
        runs: list[ReimbursementRun] = []
        for payload in payloads:
            try:
                run = ReimbursementRun.model_validate(json.loads(payload))
            except Exception:  # noqa: BLE001 — a corrupt row must not break the inbox
                logger.warning("skipped an unparseable reimbursement run row", exc_info=True)
                continue
            if run.workspace_id == workspace_id:
                runs.append(run)
        return runs
    # In-memory fallback: the orchestrator's own registry.
    in_memory = getattr(reimbursement, "_runs_by_id", {})
    return [run for run in in_memory.values() if run.workspace_id == workspace_id]


def workspace_approvals(reimbursement: Any, workspace_id: str) -> list[dict[str, Any]]:
    """The full projection for a workspace (load + project). Read-only."""
    return project_runs(load_workspace_runs(reimbursement, workspace_id))
