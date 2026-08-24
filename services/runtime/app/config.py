from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any


DEFAULT_REIMBURSEMENT_SKILL_ID = "reimbursement/travel-expense"
DEFAULT_ASSOCIATE_RECEIVABLES_SKILL_ID = "associate/receivables-recovery"
DEFAULT_CHAT_SKILL_ID = "chat/general-assistant"
DEFAULT_HIKER_ASSISTANT_SKILL_ID = "hiker/global-customer"

# Valid sampling ranges (OpenAI-compatible contract). Shared with the streaming
# producer's loud gate (engine/streaming_model.py) so both boundaries agree.
MODEL_TEMPERATURE_MIN = 0.0
MODEL_TEMPERATURE_MAX = 2.0

# J2 判断力轮:一次终态判定最多允许几次自动补办 —— 配置的硬天花板。Each continuation
# is a full engine segment PLUS a re-judge, all inside the user's single request,
# so a fat-fingered ``max_continuations: 50`` must not be honored.
MAX_EVALUATION_CONTINUATIONS = 3


@dataclass(frozen=True)
class RuntimeSettings:
    model_provider: str = "openai-compatible"
    model_endpoint: str | None = None
    model_name: str = "mimo-v2.5-pro"
    model_api_key: str | None = None
    # When set (e.g. "high"/"max"), enables provider-side deep-thinking/reasoning.
    model_reasoning_effort: str | None = None
    # Optional sampling parameters, injected into model requests ONLY when set
    # (None → key absent → wire payload unchanged). ``from_env`` coerces
    # unparseable/out-of-range values (temperature outside [0, 2], max_tokens
    # < 1) to None, mirroring ``_int_setting_value``'s silent-drop precedent;
    # the streaming producer re-checks loudly for directly-constructed
    # settings (ADR-002 code gate).
    model_temperature: float | None = None
    model_max_tokens: int | None = None
    # Optional explicit context window (tokens). Model-agnostic: when unset, the
    # Harness falls back to the default window (or a ``[1m]`` marker in the name).
    model_context_window: int | None = None
    context_compaction_enabled: bool = True
    # L4a P1 上下文治理:LLM-summary autocompact layer switch (default ON). Config
    # lives under ``runtime.json → context: {autocompact_enabled: bool}``; the env
    # kill-switch ``ANNA_CONTEXT_AUTOCOMPACT_ENABLED`` overrides it. Gated ALSO by
    # ``context_compaction_enabled`` (the whole compaction family off => off).
    context_autocompact_enabled: bool = True
    # L5 P4 并行隔离:concurrency governance knobs, read from the nested
    # ``runtime.json → concurrency: {per_workspace_runs, model_calls_per_minute}``
    # block (same env-over-file precedence as ``context``). Defaults are generous
    # enough that a single-user desktop never queues and never rate-waits;
    # invalid/non-positive values coerce back to these defaults.
    concurrency_per_workspace_runs: int = 3
    concurrency_model_calls_per_minute: int = 30
    # J2 判断力轮 Evaluator:宣布办妥前先过判断层的开关与自动补办上限,读自嵌套
    # ``runtime.json → evaluation: {enabled, max_continuations}`` 块(同 context /
    # concurrency 的 env-over-file 优先级)。``enabled=false`` → 零评估直接 ready;
    # ``max_continuations`` 界定一次终态判定最多几次自动补办(默认 1)。
    evaluation_enabled: bool = True
    # Clamped to ``MAX_EVALUATION_CONTINUATIONS`` at parse time — see ``from_env``.
    evaluation_max_continuations: int = 1
    reimbursement_mcp_server: str | None = None
    reimbursement_mcp_api_key: str | None = None
    reimbursement_skill_id: str = DEFAULT_REIMBURSEMENT_SKILL_ID
    reimbursement_probe_draft: dict[str, Any] | None = None
    erp_mcp_server: str | None = None
    erp_mcp_api_key: str | None = None
    hiker_mcp_server: str | None = None
    hiker_mcp_api_key: str | None = None
    hiker_default_actor: str = "admin"
    hiker_assistant_skill_id: str = DEFAULT_HIKER_ASSISTANT_SKILL_ID
    associate_receivables_skill_id: str = DEFAULT_ASSOCIATE_RECEIVABLES_SKILL_ID
    chat_skill_id: str = DEFAULT_CHAT_SKILL_ID
    create_workspace_root: str | None = None
    memory_db_path: str | None = None
    state_db_path: str | None = None
    # L2 Run 持久化 (P2 状态外置):chat/create run 落库路径。默认与 state_db_path
    # 同目录(下方 from_env 从解析后的 state_db_path 派生),所以任何把 state DB
    # 隔离到临时目录的测试/部署都自动隔离了 runs DB —— 无需各自再设 env。
    runs_db_path: str | None = None
    runtime_config_path: str | None = None
    # P3 refinement — multi-LLM profiles + per-agent Boss directives. Both live
    # in runtime.json (keys `model_profiles` / `agent_directives`); env has no
    # equivalent. EDITING follows the existing save→restart model; SELECTING
    # among loaded profiles is per-run and needs no restart.
    model_profiles: tuple[dict[str, Any], ...] = ()
    agent_directives: dict[str, str] = field(default_factory=dict)

    def list_model_profiles(self) -> list[dict[str, Any]]:
        """Sanitized profile list for selection UIs — never leaks api_key/endpoint."""
        profiles: list[dict[str, Any]] = []
        for raw in self.model_profiles:
            profile_id = str(raw.get("id") or "").strip()
            if not profile_id:
                continue
            profiles.append(
                {
                    "id": profile_id,
                    "label": str(raw.get("label") or raw.get("model_name") or profile_id),
                    "provider": str(raw.get("provider") or self.model_provider),
                    "model_name": str(raw.get("model_name") or self.model_name),
                }
            )
        if self.model_endpoint and not any(p["id"] == "default" for p in profiles):
            profiles.insert(
                0,
                {
                    "id": "default",
                    "label": self.model_name,
                    "provider": self.model_provider,
                    "model_name": self.model_name,
                },
            )
        return profiles

    def resolve_model_profile(self, profile_id: str | None) -> "RuntimeSettings":
        """Settings variant for a profile; None/"default" → self; unknown → KeyError."""
        if not profile_id or profile_id == "default":
            return self
        for raw in self.model_profiles:
            if str(raw.get("id") or "").strip() == profile_id:
                return replace(
                    self,
                    model_endpoint=raw.get("endpoint") or self.model_endpoint,
                    model_name=raw.get("model_name") or self.model_name,
                    model_api_key=raw.get("api_key") or self.model_api_key,
                    model_provider=raw.get("provider") or self.model_provider,
                )
        raise KeyError(profile_id)

    def agent_directive(self, agent_id: str) -> str | None:
        """Boss 附加指令 for one agent (stripped), or None when unset/blank."""
        text = (self.agent_directives.get(agent_id) or "").strip()
        return text or None

    @classmethod
    def from_env(cls) -> "RuntimeSettings":
        runtime_config_path = _blank_to_none(os.getenv("ANNA_RUNTIME_CONFIG_PATH"))
        config = _load_config(runtime_config_path)
        # Resolve state_db_path first so runs_db_path can co-locate with it
        # (same directory) — the runs DB then inherits whatever isolation a
        # caller applied to ANNA_STATE_DB_PATH without needing its own override.
        resolved_state_db_path = _setting_value(
            "ANNA_STATE_DB_PATH",
            config,
            "state_db_path",
            _default_state_db_path(runtime_config_path),
        )
        return cls(
            model_provider=_setting_value(
                "ANNA_MODEL_PROVIDER",
                config,
                "model_provider",
                "openai-compatible",
            ),
            model_endpoint=_setting_value(
                "ANNA_MODEL_ENDPOINT",
                config,
                "model_endpoint",
            ),
            model_name=_setting_value(
                "ANNA_MODEL_NAME",
                config,
                "model_name",
                "mimo-v2.5-pro",
            ),
            model_api_key=_setting_value("ANNA_MODEL_API_KEY", config, "model_api_key"),
            model_reasoning_effort=_setting_value(
                "ANNA_MODEL_REASONING_EFFORT",
                config,
                "model_reasoning_effort",
            ),
            model_temperature=_float_setting_value(
                "ANNA_MODEL_TEMPERATURE",
                config,
                "model_temperature",
                minimum=MODEL_TEMPERATURE_MIN,
                maximum=MODEL_TEMPERATURE_MAX,
            ),
            model_max_tokens=_int_setting_value(
                "ANNA_MODEL_MAX_TOKENS",
                config,
                "model_max_tokens",
            ),
            model_context_window=_int_setting_value(
                "ANNA_MODEL_CONTEXT_WINDOW",
                config,
                "model_context_window",
            ),
            context_compaction_enabled=_bool_setting_value(
                "ANNA_CONTEXT_COMPACTION_ENABLED",
                config,
                "context_compaction_enabled",
                True,
            ),
            context_autocompact_enabled=_bool_setting_value(
                "ANNA_CONTEXT_AUTOCOMPACT_ENABLED",
                _context_config(config),
                "autocompact_enabled",
                True,
            ),
            # L5: ``_int_setting_value`` coerces unparseable/non-positive values
            # to None, so the ``or`` default keeps both gates on sane limits.
            concurrency_per_workspace_runs=_int_setting_value(
                "ANNA_CONCURRENCY_PER_WORKSPACE_RUNS",
                _concurrency_config(config),
                "per_workspace_runs",
            ) or 3,
            concurrency_model_calls_per_minute=_int_setting_value(
                "ANNA_CONCURRENCY_MODEL_CALLS_PER_MINUTE",
                _concurrency_config(config),
                "model_calls_per_minute",
            ) or 30,
            evaluation_enabled=_bool_setting_value(
                "ANNA_EVALUATION_ENABLED",
                _evaluation_config(config),
                "enabled",
                True,
            ),
            # ``_int_setting_value`` coerces unparseable/non-positive to None, so
            # the ``or 1`` default keeps a sane bound (mirrors concurrency); the
            # CEILING is clamped in code because a typo'd config would otherwise
            # authorize N engine segments + N judge calls inside one user request.
            evaluation_max_continuations=min(
                _int_setting_value(
                    "ANNA_EVALUATION_MAX_CONTINUATIONS",
                    _evaluation_config(config),
                    "max_continuations",
                ) or 1,
                MAX_EVALUATION_CONTINUATIONS,
            ),
            reimbursement_mcp_server=_setting_value(
                "ANNA_REIMBURSEMENT_MCP_SERVER",
                config,
                "reimbursement_mcp_server",
            ),
            reimbursement_mcp_api_key=_setting_value(
                "ANNA_REIMBURSEMENT_MCP_API_KEY",
                config,
                "reimbursement_mcp_api_key",
            ),
            reimbursement_skill_id=_setting_value(
                "ANNA_REIMBURSEMENT_SKILL_ID",
                config,
                "reimbursement_skill_id",
                DEFAULT_REIMBURSEMENT_SKILL_ID,
            ) or DEFAULT_REIMBURSEMENT_SKILL_ID,
            reimbursement_probe_draft=_dict_setting_value(
                config,
                "reimbursement_probe_draft",
            ),
            erp_mcp_server=_setting_value(
                "ANNA_ERP_MCP_SERVER",
                config,
                "erp_mcp_server",
            ),
            erp_mcp_api_key=_setting_value(
                "ANNA_ERP_MCP_API_KEY",
                config,
                "erp_mcp_api_key",
            ),
            hiker_mcp_server=_setting_value("ANNA_HIKER_MCP_SERVER", config, "hiker_mcp_server"),
            hiker_mcp_api_key=_setting_value("ANNA_HIKER_MCP_API_KEY", config, "hiker_mcp_api_key"),
            hiker_default_actor=_setting_value(
                "ANNA_HIKER_DEFAULT_ACTOR", config, "hiker_default_actor", "admin"
            ) or "admin",
            hiker_assistant_skill_id=_setting_value(
                "ANNA_HIKER_ASSISTANT_SKILL_ID", config, "hiker_assistant_skill_id", DEFAULT_HIKER_ASSISTANT_SKILL_ID
            ) or DEFAULT_HIKER_ASSISTANT_SKILL_ID,
            associate_receivables_skill_id=_setting_value(
                "ANNA_ASSOCIATE_RECEIVABLES_SKILL_ID",
                config,
                "associate_receivables_skill_id",
                DEFAULT_ASSOCIATE_RECEIVABLES_SKILL_ID,
            ) or DEFAULT_ASSOCIATE_RECEIVABLES_SKILL_ID,
            chat_skill_id=_setting_value(
                "ANNA_CHAT_SKILL_ID",
                config,
                "chat_skill_id",
                DEFAULT_CHAT_SKILL_ID,
            ) or DEFAULT_CHAT_SKILL_ID,
            create_workspace_root=_setting_value(
                "ANNA_CREATE_WORKSPACE_ROOT",
                config,
                "create_workspace_root",
                _default_create_workspace_root(runtime_config_path),
            ),
            memory_db_path=_setting_value(
                "ANNA_MEMORY_DB_PATH",
                config,
                "memory_db_path",
                _default_memory_db_path(runtime_config_path),
            ),
            state_db_path=resolved_state_db_path,
            runs_db_path=_setting_value(
                "ANNA_RUNS_DB_PATH",
                config,
                "runs_db_path",
                _default_runs_db_path(resolved_state_db_path),
            ),
            runtime_config_path=runtime_config_path,
            model_profiles=(
                tuple(p for p in config["model_profiles"] if isinstance(p, dict))
                if isinstance(config.get("model_profiles"), list)
                else ()
            ),
            agent_directives=(
                {str(k): str(v) for k, v in config["agent_directives"].items()}
                if isinstance(config.get("agent_directives"), dict)
                else {}
            ),
        )


def _blank_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _setting_value(
    env_name: str,
    config: dict[str, Any],
    config_key: str,
    default: str | None = None,
) -> str | None:
    env_value = _blank_to_none(os.getenv(env_name))
    if env_value is not None:
        return env_value
    config_value = config.get(config_key)
    if config_value is None:
        return default
    return _blank_to_none(str(config_value)) or default


def _dict_setting_value(config: dict[str, Any], config_key: str) -> dict[str, Any] | None:
    config_value = config.get(config_key)
    if isinstance(config_value, dict):
        return config_value
    return None


def _int_setting_value(
    env_name: str,
    config: dict[str, Any],
    config_key: str,
) -> int | None:
    raw = _setting_value(env_name, config, config_key)
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _float_setting_value(
    env_name: str,
    config: dict[str, Any],
    config_key: str,
    *,
    minimum: float,
    maximum: float,
) -> float | None:
    """Parse a float setting; unparseable or out-of-range values coerce to
    None, mirroring ``_int_setting_value``'s silent-drop precedent. NaN fails
    the range comparison and coerces to None too."""
    raw = _setting_value(env_name, config, config_key)
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if minimum <= value <= maximum else None


def _bool_setting_value(
    env_name: str,
    config: dict[str, Any],
    config_key: str,
    default: bool,
) -> bool:
    raw = _setting_value(env_name, config, config_key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _context_config(config: dict[str, Any]) -> dict[str, Any]:
    """The nested ``context`` config block (``{}`` when absent/malformed).

    Lets ``_bool_setting_value`` read ``context.autocompact_enabled`` with the
    same env-over-file precedence as every flat setting.
    """
    nested = config.get("context")
    return nested if isinstance(nested, dict) else {}


def _concurrency_config(config: dict[str, Any]) -> dict[str, Any]:
    """The nested ``concurrency`` config block (``{}`` when absent/malformed).

    L5 twin of ``_context_config``: lets ``_int_setting_value`` read
    ``concurrency.per_workspace_runs`` / ``concurrency.model_calls_per_minute``
    with the same env-over-file precedence as every flat setting.
    """
    nested = config.get("concurrency")
    return nested if isinstance(nested, dict) else {}


def _evaluation_config(config: dict[str, Any]) -> dict[str, Any]:
    """The nested ``evaluation`` config block (``{}`` when absent/malformed).

    J2 twin of ``_context_config`` / ``_concurrency_config``: lets the settings
    readers pull ``evaluation.enabled`` / ``evaluation.max_continuations`` with the
    same env-over-file precedence as every flat setting.
    """
    nested = config.get("evaluation")
    return nested if isinstance(nested, dict) else {}


def _load_config(config_path: str | None) -> dict[str, Any]:
    if not config_path:
        return {}
    path = Path(config_path)
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as file:
        config = json.load(file)
    if not isinstance(config, dict):
        return {}
    return config


def _default_state_db_path(runtime_config_path: str | None) -> str:
    if runtime_config_path:
        config_dir = Path(runtime_config_path).parent
        state_root = config_dir.parent / "state" if config_dir.name == "config" else config_dir / "state"
        return str(state_root / "anna-state.sqlite3")
    return str(Path.cwd() / ".anna" / "state" / "anna-state.sqlite3")


def _default_runs_db_path(state_db_path: str | None) -> str:
    """L2 run store path — co-located with the state DB (same directory).

    Deriving from the resolved ``state_db_path`` (rather than re-deriving from
    ``runtime_config_path``) means the runs DB lands in the SAME directory the
    state/identity/crew DBs already use: ``.anna/state/anna-runs.sqlite3`` in
    production, and an isolated tmp dir whenever a caller points
    ``ANNA_STATE_DB_PATH`` at one. No separate isolation knob needed.
    """
    if state_db_path:
        return str(Path(state_db_path).parent / "anna-runs.sqlite3")
    return str(Path.cwd() / ".anna" / "state" / "anna-runs.sqlite3")


def _default_create_workspace_root(runtime_config_path: str | None) -> str:
    if runtime_config_path:
        config_dir = Path(runtime_config_path).parent
        state_root = config_dir.parent / "state" if config_dir.name == "config" else config_dir / "state"
        return str(state_root / "create-runs")
    return str(Path.cwd() / ".anna" / "create-runs")


def _default_memory_db_path(runtime_config_path: str | None) -> str:
    if runtime_config_path:
        config_dir = Path(runtime_config_path).parent
        state_root = config_dir.parent / "state" if config_dir.name == "config" else config_dir / "state"
        return str(state_root / "anna-memory.sqlite3")
    return str(Path.cwd() / ".anna" / "state" / "anna-memory.sqlite3")
