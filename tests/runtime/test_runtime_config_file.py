import json

from services.runtime.app.config import (
    DEFAULT_REIMBURSEMENT_SKILL_ID,
    RuntimeSettings,
)


def test_runtime_settings_defaults_to_travel_reimbursement_skill(monkeypatch):
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)
    monkeypatch.delenv("ANNA_REIMBURSEMENT_SKILL_ID", raising=False)

    settings = RuntimeSettings.from_env()

    assert settings.reimbursement_skill_id == DEFAULT_REIMBURSEMENT_SKILL_ID


def test_runtime_settings_load_model_and_mcp_from_config_file(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps(
            {
                "model_provider": "openai-compatible",
                "model_endpoint": "https://model.example/v1/chat/completions",
                "model_name": "mimo-v2.5-pro",
                "model_api_key": "secret-key",
                "reimbursement_mcp_server": "https://mcp.example/rpc",
                "reimbursement_mcp_api_key": "mcp-secret-key",
                "reimbursement_skill_id": "reimbursement/custom-travel",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_API_KEY", raising=False)

    settings = RuntimeSettings.from_env()

    assert settings.runtime_config_path == str(config_path)
    assert settings.model_endpoint == "https://model.example/v1/chat/completions"
    assert settings.model_api_key == "secret-key"
    assert settings.reimbursement_mcp_server == "https://mcp.example/rpc"
    assert settings.reimbursement_mcp_api_key == "mcp-secret-key"
    assert settings.reimbursement_skill_id == "reimbursement/custom-travel"


def test_runtime_settings_loads_reimbursement_probe_draft(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    probe_draft = {
        "category": "travel",
        "amount": 88,
        "currency": "CNY",
        "expense_date": "2026-06-01",
        "merchant": "真实差旅供应商",
        "reason": "真实连接器只读探针",
        "department_id": "sales-real",
        "cost_center_id": "cc-real",
        "attachments": [],
    }
    config_path.write_text(
        json.dumps({"reimbursement_probe_draft": probe_draft}, ensure_ascii=False),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))

    settings = RuntimeSettings.from_env()

    assert settings.reimbursement_probe_draft == probe_draft


def test_runtime_settings_environment_overrides_config_file(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps(
            {
                "model_endpoint": "https://model-from-file.example/v1",
                "model_api_key": "file-key",
                "reimbursement_mcp_server": "https://mcp-from-file.example/rpc",
                "reimbursement_mcp_api_key": "file-mcp-key",
                "reimbursement_skill_id": "reimbursement/file-skill",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("ANNA_MODEL_ENDPOINT", "https://model-from-env.example/v1")
    monkeypatch.setenv("ANNA_MODEL_API_KEY", "env-key")
    monkeypatch.setenv("ANNA_REIMBURSEMENT_MCP_SERVER", "https://mcp-from-env.example/rpc")
    monkeypatch.setenv("ANNA_REIMBURSEMENT_MCP_API_KEY", "env-mcp-key")
    monkeypatch.setenv("ANNA_REIMBURSEMENT_SKILL_ID", "reimbursement/env-skill")

    settings = RuntimeSettings.from_env()

    assert settings.model_endpoint == "https://model-from-env.example/v1"
    assert settings.model_api_key == "env-key"
    assert settings.reimbursement_mcp_server == "https://mcp-from-env.example/rpc"
    assert settings.reimbursement_mcp_api_key == "env-mcp-key"
    assert settings.reimbursement_skill_id == "reimbursement/env-skill"


def test_runtime_settings_sampling_params_default_to_none(monkeypatch):
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)
    monkeypatch.delenv("ANNA_MODEL_TEMPERATURE", raising=False)
    monkeypatch.delenv("ANNA_MODEL_MAX_TOKENS", raising=False)

    settings = RuntimeSettings.from_env()

    assert settings.model_temperature is None
    assert settings.model_max_tokens is None


def test_autocompact_enabled_defaults_on_and_reads_nested_context(monkeypatch, tmp_path):
    # L4a: default ON; the nested runtime.json `context.autocompact_enabled` block
    # can turn it off; the env kill-switch overrides the file.
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)
    monkeypatch.delenv("ANNA_CONTEXT_AUTOCOMPACT_ENABLED", raising=False)
    assert RuntimeSettings.from_env().context_autocompact_enabled is True

    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps({"context": {"autocompact_enabled": False}}), encoding="utf-8"
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    assert RuntimeSettings.from_env().context_autocompact_enabled is False

    # Env kill-switch wins over the file (here: re-enables).
    monkeypatch.setenv("ANNA_CONTEXT_AUTOCOMPACT_ENABLED", "true")
    assert RuntimeSettings.from_env().context_autocompact_enabled is True


def test_runtime_settings_load_sampling_params_from_config_file(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps({"model_temperature": 0.2, "model_max_tokens": 1024}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_MODEL_TEMPERATURE", raising=False)
    monkeypatch.delenv("ANNA_MODEL_MAX_TOKENS", raising=False)

    settings = RuntimeSettings.from_env()

    assert settings.model_temperature == 0.2
    assert settings.model_max_tokens == 1024


def test_runtime_settings_sampling_env_overrides_config_file(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps({"model_temperature": 0.2, "model_max_tokens": 1024}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("ANNA_MODEL_TEMPERATURE", "0.7")
    monkeypatch.setenv("ANNA_MODEL_MAX_TOKENS", "2048")

    settings = RuntimeSettings.from_env()

    assert settings.model_temperature == 0.7
    assert settings.model_max_tokens == 2048


def test_runtime_settings_coerce_invalid_sampling_values_to_none(monkeypatch):
    # Mirrors _int_setting_value's silent-drop precedent (model_context_window):
    # unparseable or out-of-range env/file values coerce to None instead of
    # poisoning every downstream model call. temperature must sit in [0, 2];
    # max_tokens must be >= 1.
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)

    for bad_temperature in ("abc", "5.0", "-0.1", "nan"):
        monkeypatch.setenv("ANNA_MODEL_TEMPERATURE", bad_temperature)
        assert RuntimeSettings.from_env().model_temperature is None, bad_temperature
    monkeypatch.delenv("ANNA_MODEL_TEMPERATURE", raising=False)

    for bad_max_tokens in ("abc", "0", "-5", "1.5"):
        monkeypatch.setenv("ANNA_MODEL_MAX_TOKENS", bad_max_tokens)
        assert RuntimeSettings.from_env().model_max_tokens is None, bad_max_tokens
    monkeypatch.delenv("ANNA_MODEL_MAX_TOKENS", raising=False)

    # Boundary values are valid, not dropped.
    monkeypatch.setenv("ANNA_MODEL_TEMPERATURE", "0")
    monkeypatch.setenv("ANNA_MODEL_MAX_TOKENS", "1")
    settings = RuntimeSettings.from_env()
    assert settings.model_temperature == 0.0
    assert settings.model_max_tokens == 1


def test_runtime_settings_accepts_inclusive_upper_temperature_boundary(monkeypatch):
    # The `<=` upper edge is inclusive: temperature == 2 is kept, not dropped.
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)
    monkeypatch.setenv("ANNA_MODEL_TEMPERATURE", "2")

    assert RuntimeSettings.from_env().model_temperature == 2.0


def test_runtime_settings_defaults_state_db_next_to_runtime_config(
    monkeypatch,
    tmp_path,
):
    config_path = tmp_path / "config" / "runtime.json"
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_STATE_DB_PATH", raising=False)

    settings = RuntimeSettings.from_env()

    assert settings.state_db_path == str(tmp_path / "state" / "anna-state.sqlite3")
