"""Run the real Crew matcher against a running protected Host.

The process receives only a synthetic fair state and Host origin/token. It does
not load runtime.json, model credentials, or fixture labels.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from services.business.harness_client import HarnessHostClient
from services.business.host_runtime import HostHarnessRuntime
from services.business.mode import BusinessModeConfig
from services.crew.app.matching import CrewMatchingService
from services.crew.app.schemas import CrewProject, CrewTask
from services.identity.app.schemas import Account


class RecordingHostClient(HarnessHostClient):
    def __init__(self, config: BusinessModeConfig) -> None:
        super().__init__(config)
        self.runs: list[dict[str, Any]] = []

    def submit_and_wait(self, task, *, timeout_seconds=None):  # type: ignore[no-untyped-def]
        run = super().submit_and_wait(task, timeout_seconds=timeout_seconds)
        self.runs.append({
            "run_ref": run.run_id,
            "status": run.status,
            "events": list(run.events),
            "result": run.result,
        })
        return run


def main() -> None:
    payload = json.load(sys.stdin)
    state = payload["state"]
    case_id = payload["case_id"]
    origin = str(payload["host_origin"])
    token = str(payload["service_token"])
    config = BusinessModeConfig(enabled=True, host_origin=origin, service_token=token)
    config.require_enabled()
    client = RecordingHostClient(config)
    matching = CrewMatchingService(harness_runtime=HostHarnessRuntime(client))
    task_data = state["task"]
    task = CrewTask(
        id=f"task-{case_id}", project_id=f"project-{case_id}", key=case_id,
        title=task_data["title"], description=task_data.get("description") or "",
        role_required=task_data["role_required"], assignee_member_id=None,
    )
    members = [Account(
        id=candidate["id"], workspace_id=f"jev-eval-{payload['split']}",
        email=f"{candidate['id']}@synthetic.invalid",
        display_name=candidate.get("display_name") or candidate["id"],
        role=candidate["role"], kind=candidate["kind"],
    ) for candidate in state.get("candidates", [])]
    project = CrewProject(
        id=f"project-{case_id}", workspace_id=f"jev-eval-{payload['split']}",
        owner_user_id="jev-eval-reviewer", goal_text=state["project_goal"],
        sop_template_id="jev-eval", tasks=[task],
    )
    proposals = matching.propose(project, members)
    proposal = proposals[0]
    events = [event for run in client.runs for event in run.get("events", [])]
    model_requests = [event for event in events if event.get("type") == "run.model.requested"]
    usage_events = [event for event in events if event.get("type") == "run.usage.updated"]
    latest_usage = (usage_events[-1].get("payload", {}).get("cumulative", {}) if usage_events else {})
    dispatched = {
        event.get("payload", {}).get("toolCallId") or event.get("payload", {}).get("tool_call_id"): event.get("payload", {}).get("tool") or event.get("payload", {}).get("tool_name")
        for event in events
        if event.get("type") == "omp.tool.dispatch"
        and isinstance(event.get("payload", {}).get("tool") or event.get("payload", {}).get("tool_name"), str)
    }
    tool_responses = [event for event in events if event.get("type") == "omp.tool.response"]
    successful_emit = any(
        event.get("payload", {}).get("result", {}).get("status") == "succeeded"
        and dispatched.get(event.get("payload", {}).get("toolCallId") or event.get("payload", {}).get("tool_call_id"), "").replace("__", ".") == "crew.emit_assignments"
        for event in tool_responses
    )
    model_called = len(model_requests) > 0
    source = "crew_model" if successful_emit else "crew_fallback_unattributed"
    print(json.dumps({
        "status": "suggested" if proposal.member_id else "abstained",
        "member_id": proposal.member_id,
        "source": source,
        "provider_called": model_called,
        "provider_calls": len(model_requests),
        "requested_model": next((event.get("payload", {}).get("model") for event in model_requests if isinstance(event.get("payload", {}).get("model"), str)), None),
        "returned_model": None,
        "meta": {
            "provider_calls": len(model_requests),
            "input_tokens": latest_usage.get("input") if isinstance(latest_usage.get("input"), int) else None,
            "output_tokens": latest_usage.get("output") if isinstance(latest_usage.get("output"), int) else None,
        },
        "run_refs": [run["run_ref"] for run in client.runs],
        "host_statuses": [run["status"] for run in client.runs],
        "host_errors": [
            next((run.get("result", {}).get(key) for key in ("error_code", "code", "error") if isinstance(run.get("result"), dict) and isinstance(run.get("result", {}).get(key), str)), None)
            for run in client.runs
        ],
        "host_event_types": [[event.get("type") for event in run.get("events", [])] for run in client.runs],
        "host_failures": [
            next((event.get("payload") for event in run.get("events", []) if event.get("type") == "run.failed"), None)
            for run in client.runs
        ],
        "host_eval": [
            next((event.get("payload") for event in run.get("events", []) if event.get("type") == "run.eval.contract"), None)
            for run in client.runs
        ],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
