from __future__ import annotations

import hashlib
import json
from typing import Any, Callable

from services.runtime.app.skill_loader import LoadedSkill, SkillLoaderError


class BaseOrchestrator:
    """Shared private bookkeeping for Anna domain orchestrators.

    This base hosts the helpers that used to be copy-pasted across the chat,
    finance, associate, reimbursement, and create orchestrators. Behavior is
    parameterized only through class attributes so that no audit event name,
    error code, run status, or payload field changes:

    - ``_fail_event_type`` / ``_fail_payload_includes_message`` keep the
      per-domain ``*.failed`` event names and payload shapes.
    - ``_hash_payload_ensure_ascii`` keeps chat's historical
      ``ensure_ascii=False`` hashing while the other domains hash with
      ``ensure_ascii=True``.
    - ``_run_id_prefix`` / ``_approval_id_prefix`` / ``_write_id_prefix`` keep
      the per-domain id formats, including the ``state_store``-backed sequence
      variants used by associate and reimbursement.

    Concrete orchestrators keep their own public constructors; this class
    only relies on the attributes they already set (``audit``,
    ``skill_loader``, counters, and optionally ``state_store``).
    """

    _fail_event_type: str = "run.failed"
    _fail_payload_includes_message: bool = True
    _hash_payload_ensure_ascii: bool = True
    _run_id_prefix: str = "run_"
    _approval_id_prefix: str = "approval_"
    _write_id_prefix: str = "write_"

    def _hash_payload(self, payload: dict[str, Any]) -> str:
        encoded = json.dumps(
            payload,
            sort_keys=True,
            ensure_ascii=self._hash_payload_ensure_ascii,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _fail_run(self, run: Any, error_code: str, message: str) -> Any:
        return self._fail_run_event(run, self._fail_event_type, error_code, message)

    def _fail_run_event(
        self,
        run: Any,
        event_type: str,
        error_code: str,
        message: str,
    ) -> Any:
        run.status = "failed"
        run.error_code = error_code
        run.error_message = message
        payload: dict[str, Any] = {"error_code": error_code}
        if self._fail_payload_includes_message:
            payload["message"] = message
        self.audit.append(run.audit_events, event_type, run.id, payload)
        return run

    def _next_run_id(self) -> str:
        state_store = getattr(self, "state_store", None)
        if state_store is not None:
            return f"{self._run_id_prefix}{state_store.next_run_sequence():03d}"
        self._run_counter += 1
        return f"{self._run_id_prefix}{self._run_counter:03d}"

    def _next_approval_id(self) -> str:
        state_store = getattr(self, "state_store", None)
        if state_store is not None:
            return (
                f"{self._approval_id_prefix}{state_store.next_approval_sequence():03d}"
            )
        self._approval_counter += 1
        return f"{self._approval_id_prefix}{self._approval_counter:03d}"

    def _next_write_id(self) -> str:
        state_store = getattr(self, "state_store", None)
        if state_store is not None:
            return f"{self._write_id_prefix}{state_store.next_write_sequence():03d}"
        self._write_counter += 1
        return f"{self._write_id_prefix}{self._write_counter:03d}"

    def _record_skill_loaded(self, run: Any, skill: LoadedSkill) -> None:
        self.audit.append(
            run.audit_events,
            "skill.loaded",
            run.id,
            {
                "skill_id": skill.id,
                "skill_name": skill.name,
                "skill_version": skill.version,
                "content_hash": skill.content_hash,
            },
        )

    def _load_skill_and_record(
        self,
        run: Any,
        skill_id: str,
        fail_run: Callable[[Any, str, str], Any] | None = None,
    ) -> tuple[LoadedSkill | None, Any | None]:
        """Load a Skill and audit ``skill.loaded``, or fail the run.

        Returns ``(skill, None)`` on success and ``(None, failed_run)`` when
        the Skill cannot be loaded.
        """
        fail = fail_run if fail_run is not None else self._fail_run
        try:
            skill = self.skill_loader.load(skill_id)
        except SkillLoaderError as exc:
            return None, fail(run, exc.error_code, exc.message)
        self._record_skill_loaded(run, skill)
        return skill, None
