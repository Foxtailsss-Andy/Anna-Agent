---
name: crew-project-management
version: 0.1.0
allowed_tools:
  - read_only
  - todo
  - crew.emit_project_plan
  - crew.emit_assignments
  - crew.emit_task_drafts
forbidden_tools:
  - crew.execute_task
  - crew.delete_project
---

# Crew Project Management

Use this Skill for scoped Crew project, channel, task, and assignment work.
Keep proposals tied to the authenticated project context and preserve the
existing review, approval, and artifact lifecycle. Emit plans or task drafts
through the approved Crew tools; do not claim that a proposal was executed.
