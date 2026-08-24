from __future__ import annotations

import ast
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SERVICES_ROOT = ROOT / "services"
CJK_RE = re.compile(r"[\u3400-\u9fff]")


def _docstring_ids(tree: ast.AST) -> set[int]:
    owners = [tree, *(node for node in ast.walk(tree) if isinstance(
        node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
    ))]
    return {
        id(owner.body[0].value)
        for owner in owners
        if getattr(owner, "body", None)
        and isinstance(owner.body[0], ast.Expr)
        and isinstance(owner.body[0].value, ast.Constant)
        and isinstance(owner.body[0].value.value, str)
    }


def _is_code_like(value: str) -> bool:
    if any(marker in value for marker in ("(?:", "[^", r"\b", "{0,")):
        return True
    cjk_count = len(CJK_RE.findall(value))
    return bool(value) and value[0].isascii() and value[0].isalpha() and cjk_count < len(value) / 4


def _violation(value: str) -> str | None:
    if any(mark in value for mark in "「」『』"):
        return "使用了非大陆中文常用引号"
    if not CJK_RE.search(value) or _is_code_like(value):
        return None
    if re.search(r"\.\.\.|(?<!…)…(?!…)", value):
        return "省略号不是六点形式"
    if re.search(r"[\u3400-\u9fff”’）》】）][,:;!?]|[,:;!?][\u3400-\u9fff“‘（《【]", value):
        return "中文句内使用了半角标点"
    if re.search(r"\s/\s|[\u3400-\u9fff]/[\u3400-\u9fffA-Za-z@]|[A-Za-z@\u3400-\u9fff]/[\u3400-\u9fff]", value):
        return "中文并列或选择关系使用了斜杠"
    if re.search(r"[，：；！？] +", value):
        return "中文标点后存在多余空格"
    if "(" in value or ")" in value:
        return "中文语境使用了半角圆括号"
    return None


def test_backend_user_text_uses_standard_chinese_punctuation() -> None:
    failures: list[str] = []

    for path in sorted(SERVICES_ROOT.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        docstrings = _docstring_ids(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            if id(node) in docstrings:
                continue
            reason = _violation(node.value)
            if reason:
                failures.append(f"{path.relative_to(ROOT)}:{node.lineno} {reason}: {node.value!r}")

    assert not failures, "\n".join(failures)
