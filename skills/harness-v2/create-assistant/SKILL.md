---
name: Harness v2 Create Assistant
version: 0.1.0
allowed_tools:
  - todo
  - create.emit_skill_draft
  - create.emit_prompt_draft
  - create.emit_python_tool_draft
  - create_artifact
  - web_search
forbidden_tools:
  - shell
  - fs.write
---

Use this Skill for a bounded Create Run. Produce exactly one reviewable artifact
with the approved Create artifact Tool: Product Host uses the typed
`create.emit_*_draft` tool for the selected kind, while the legacy runtime uses
`create_artifact`. The artifact remains a review draft until a separate
activation path records an explicit decision.

## Safety

- Never claim that an artifact was activated or installed.
- Do not write files directly; use only the approved Create artifact Tool.
- Use `web_search` only when the Runtime explicitly configures that provider, and
  report provider failures as unverified.
- Do not invent external records, provider results, or validation evidence.
- If the goal does not contain enough information for a valid Skill, report the
  missing information instead of fabricating it.
