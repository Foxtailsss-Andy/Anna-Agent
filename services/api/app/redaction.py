from __future__ import annotations

import re
from typing import Any


def _blank_to_none(value: Any) -> str | None:
    if value is None:
        return None
    stripped = str(value).strip()
    return stripped or None


def _redact_config_display_value(value: Any) -> str | None:
    normalized = _blank_to_none(value)
    if normalized is None:
        return None
    return _redact_runtime_text(normalized)


def _is_redacted_placeholder(value: Any) -> bool:
    normalized = _blank_to_none(value)
    return normalized is not None and "[redacted]" in normalized


def _redact_runtime_status(status: dict[str, Any]) -> dict[str, Any]:
    redacted = _redact_runtime_value(status)
    if redacted.get("server"):
        redacted["server"] = "[configured]"
    return redacted


def _redact_runtime_value(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[Any, Any] = {}
        for key, item in value.items():
            if isinstance(key, str) and _is_sensitive_runtime_key(key):
                redacted[key] = "[redacted]"
            else:
                redacted[key] = _redact_runtime_value(item)
        return redacted
    if isinstance(value, list):
        return [_redact_runtime_value(item) for item in value]
    if isinstance(value, str):
        return _redact_runtime_text(value)
    return value


def _is_sensitive_runtime_key(key: str) -> bool:
    return bool(
        re.fullmatch(
            r"(?:api[_-]?key|access[_-]?token|client[_-]?secret|"
            r"clientSecret|token|secret|password|content[_-]?base64)",
            key,
            flags=re.IGNORECASE,
        )
    )


def _redact_runtime_text(value: str) -> str:
    sensitive_key = (
        r"(?:api[_-]?key|access[_-]?token|client[_-]?secret|"
        r"clientSecret|token|secret|password|content[_-]?base64)"
    )
    redacted = re.sub(r"(https?://)[^/@\s]+@", r"\1[redacted]@", value)
    redacted = re.sub(
        r"([?&](?:api[_-]?key|access[_-]?token|token|client[_-]?secret|secret|password)=)[^&\s]+",
        r"\1[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        r"((?:Authorization:\s*)?Bearer\s+)[A-Za-z0-9._~+/=-]+",
        r"\1[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        r"(ANNA_MODEL_API_KEY\s*=\s*)[^\s]+",
        r"\1[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        rf"(({sensitive_key})=)[^&\s,}}]+",
        lambda match: match.group(1) + "[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        rf'((?:"{sensitive_key}"|{sensitive_key})\s*:\s*)(["\']).*?(\2)',
        lambda match: match.group(1) + match.group(2) + "[redacted]" + match.group(3),
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        rf'((?:"{sensitive_key}"|{sensitive_key})\s*:\s*)[^\s,}}]+',
        lambda match: match.group(1) + "[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )
    return redacted
