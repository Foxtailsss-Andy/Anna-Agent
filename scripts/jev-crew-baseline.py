"""Emit one real deterministic_proposals result for the bounded Crew eval.

The evaluator deliberately calls the production Python rule through this
small process seam instead of maintaining a second JavaScript implementation.
Input and output are synthetic, single-case JSON only.
"""

from __future__ import annotations

import json
import sys

from services.crew.app.matching import deterministic_proposals
from services.crew.app.schemas import CrewProject, CrewTask
from services.identity.app.schemas import Account


def main() -> None:
    payload = json.load(sys.stdin)
    item = payload["item"]
    state = item["input"]["state"]
    task_data = state["task"]
    task = CrewTask(
        id=f"task-{item['case_id']}",
        project_id=f"project-{item['case_id']}",
        key=item["case_id"],
        title=task_data["title"],
        description=task_data.get("description") or "",
        role_required=task_data["role_required"],
        assignee_member_id=None,
    )
    members = [
        Account(
            id=candidate["id"],
            workspace_id=f"jev-eval-{item['split']}",
            email=f"{candidate['id']}@synthetic.invalid",
            display_name=candidate.get("display_name") or candidate["id"],
            role=candidate["role"],
            kind=candidate["kind"],
        )
        for candidate in state.get("candidates", [])
    ]
    project = CrewProject(
        id=f"project-{item['case_id']}",
        workspace_id=f"jev-eval-{item['split']}",
        owner_user_id="jev-eval-reviewer",
        goal_text=state["project_goal"],
        sop_template_id="jev-eval",
        tasks=[task],
    )
    proposal = deterministic_proposals(project, members)[0]
    print(json.dumps(proposal.model_dump(), ensure_ascii=False))


if __name__ == "__main__":
    main()
