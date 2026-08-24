from pathlib import Path

import pytest

from services.runtime.app.skill_loader import SkillLoader, SkillLoaderError


def test_travel_expense_skill_loads_from_disk_with_audit_metadata():
    skill = SkillLoader(project_root=Path.cwd()).load(
        "reimbursement/travel-expense"
    )

    assert skill.name == "travel-expense-reimbursement"
    assert skill.version == "0.1.0"
    assert "reimbursement.submit_intent" in skill.allowed_tools
    assert "reimbursement.submit" in skill.forbidden_tools
    assert "Never call or request a final submit tool directly" in skill.content
    assert len(skill.content_hash) == 64


def test_missing_skill_raises_skill_not_found(tmp_path):
    loader = SkillLoader(project_root=tmp_path)

    with pytest.raises(SkillLoaderError) as error:
        loader.load("reimbursement/travel-expense")

    assert error.value.error_code == "skill_not_found"


def test_skill_loader_lists_valid_skills_from_disk(tmp_path):
    write_skill(tmp_path, "reimbursement/custom-travel", "custom-travel")
    write_skill(tmp_path, "reimbursement/audit", "audit-reimbursement")
    invalid_dir = tmp_path / "skills" / "broken"
    invalid_dir.mkdir(parents=True)
    (invalid_dir / "SKILL.md").write_text("missing frontmatter", encoding="utf-8")

    skills = SkillLoader(project_root=tmp_path).list()

    assert [skill.id for skill in skills] == [
        "reimbursement/audit",
        "reimbursement/custom-travel",
    ]
    assert [skill.name for skill in skills] == [
        "audit-reimbursement",
        "custom-travel",
    ]


def write_skill(project_root: Path, skill_id: str, name: str) -> None:
    skill_dir = project_root / "skills" / skill_id
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {name}
version: 0.1.0
allowed_tools:
  - reimbursement.submit_intent
forbidden_tools:
  - reimbursement.submit
---

# {name}
""",
        encoding="utf-8",
    )
