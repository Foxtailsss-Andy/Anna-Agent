from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class SkillLoaderError(Exception):
    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message


@dataclass(frozen=True)
class LoadedSkill:
    id: str
    name: str
    version: str
    path: Path
    content: str
    content_hash: str
    allowed_tools: list[str]
    forbidden_tools: list[str]
    frontmatter: dict[str, Any]


class SkillLoader:
    def __init__(self, project_root: Path | None = None) -> None:
        self.project_root = (project_root or Path.cwd()).resolve()
        self.skills_root = (self.project_root / "skills").resolve()

    def load(self, skill_id: str) -> LoadedSkill:
        skill_path = (self.skills_root / skill_id / "SKILL.md").resolve()
        try:
            skill_path.relative_to(self.skills_root)
        except ValueError as exc:
            raise SkillLoaderError(
                "skill_path_invalid",
                "skill path must stay inside the skills directory",
            ) from exc
        if not skill_path.exists():
            raise SkillLoaderError(
                "skill_not_found",
                f"skill not found: {skill_id}",
            )

        raw_content = skill_path.read_text(encoding="utf-8")
        frontmatter, body = _parse_frontmatter(raw_content)
        name = _required_text(frontmatter, "name")
        version = _required_text(frontmatter, "version")
        return LoadedSkill(
            id=skill_id,
            name=name,
            version=version,
            path=skill_path,
            content=body,
            content_hash=hashlib.sha256(raw_content.encode("utf-8")).hexdigest(),
            allowed_tools=_string_list(frontmatter.get("allowed_tools")),
            forbidden_tools=_string_list(frontmatter.get("forbidden_tools")),
            frontmatter=frontmatter,
        )

    def load_from_path(self, skill_path: Path, skill_id: str) -> LoadedSkill:
        skill_path = skill_path.resolve()
        raw_content = skill_path.read_text(encoding="utf-8")
        frontmatter, body = _parse_frontmatter(raw_content)
        name = _required_text(frontmatter, "name")
        version = _required_text(frontmatter, "version")
        return LoadedSkill(
            id=skill_id,
            name=name,
            version=version,
            path=skill_path,
            content=body,
            content_hash=hashlib.sha256(raw_content.encode("utf-8")).hexdigest(),
            allowed_tools=_string_list(frontmatter.get("allowed_tools")),
            forbidden_tools=_string_list(frontmatter.get("forbidden_tools")),
            frontmatter=frontmatter,
        )

    def list(self) -> list[LoadedSkill]:
        if not self.skills_root.exists():
            return []
        skills: list[LoadedSkill] = []
        for skill_path in sorted(self.skills_root.glob("**/SKILL.md")):
            try:
                skill_id = skill_path.parent.relative_to(self.skills_root).as_posix()
            except ValueError:
                continue
            try:
                skills.append(self.load(skill_id))
            except SkillLoaderError:
                continue
        return sorted(skills, key=lambda skill: skill.id)


def _parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    if not content.startswith("---\n"):
        raise SkillLoaderError("skill_invalid", "skill must include YAML frontmatter")
    end = content.find("\n---\n", 4)
    if end == -1:
        raise SkillLoaderError("skill_invalid", "skill frontmatter is not closed")
    frontmatter_text = content[4:end]
    body = content[end + 5 :].lstrip()
    return _parse_simple_yaml(frontmatter_text), body


def _parse_simple_yaml(source: str) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    current_list_key: str | None = None
    for raw_line in source.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        stripped = line.strip()
        if stripped.startswith("- "):
            if current_list_key is None:
                raise SkillLoaderError("skill_invalid", "frontmatter list has no key")
            parsed.setdefault(current_list_key, []).append(stripped[2:].strip())
            continue
        if ":" not in line:
            raise SkillLoaderError("skill_invalid", f"invalid frontmatter line: {line}")
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        current_list_key = None
        if value:
            parsed[key] = value.strip("\"'")
        else:
            parsed[key] = []
            current_list_key = key
    return parsed


def _required_text(frontmatter: dict[str, Any], key: str) -> str:
    value = frontmatter.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SkillLoaderError("skill_invalid", f"skill missing {key}")
    return value


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(item) for item in value]
    raise SkillLoaderError("skill_invalid", "tool list must be a string list")
