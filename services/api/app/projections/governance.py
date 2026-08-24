from __future__ import annotations

from pathlib import Path
from typing import Any

from services.create.app.orchestrator import CreateOrchestrator
from services.create.app.sandbox import (
    DEFAULT_SANDBOX_MAX_OUTPUT_BYTES,
    DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    SANDBOX_ENV_ALLOWLIST,
    SANDBOX_PREFLIGHT_POLICY,
    SANDBOX_SECRET_BOUNDARY,
    CreateToolSandbox,
)

from ..redaction import _redact_runtime_value


def _fixture_runner_status(create: CreateOrchestrator) -> dict[str, Any]:
    workspace_root = getattr(create, "workspace_root", None)
    return {
        "status": "available" if workspace_root else "not_configured",
        "runner": "CreateToolSandbox",
        "workspace_root_configured": workspace_root is not None,
        "production_secrets_injected": False,
        "secret_boundary": SANDBOX_SECRET_BOUNDARY,
        "preflight_policy": SANDBOX_PREFLIGHT_POLICY,
        "timeout_enforced": True,
        "output_limited": True,
        "env_allowlist": list(SANDBOX_ENV_ALLOWLIST),
        "timeout_seconds": DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        "max_output_bytes": DEFAULT_SANDBOX_MAX_OUTPUT_BYTES,
        "last_probe_status": getattr(create, "last_sandbox_probe_status", "not_run"),
        "hardened_sandbox": False,
        "network_isolated": False,
    }


def _sandbox_probe_response(create: CreateOrchestrator) -> dict[str, Any]:
    probed_secret_names = [
        "ANNA_MODEL_API_KEY",
        "ANNA_REIMBURSEMENT_MCP_API_KEY",
        "ANNA_ERP_MCP_API_KEY",
    ]
    result = create.sandbox.run_python_tool(
        code=(
            "import os, sys\n"
            "payload = sys.stdin.read().strip()\n"
            "print('probe=' + payload)\n"
            "for name in ["
            "'ANNA_MODEL_API_KEY', "
            "'ANNA_REIMBURSEMENT_MCP_API_KEY', "
            "'ANNA_ERP_MCP_API_KEY'"
            "]:\n"
            "    print(name + '=' + str(os.getenv(name)))\n"
        ),
        fixture_input="admin-sandbox",
    )
    blocked_result = create.sandbox.run_python_tool(
        code="open('side-effect.txt', 'w').write('should not run')\n",
        fixture_input="{}",
    )
    probe_workspace_root = Path(getattr(create, "workspace_root", Path.cwd()))
    probe_python_executable = getattr(create.sandbox, "python_executable", None)
    timeout_probe = CreateToolSandbox(
        workspace_root=probe_workspace_root,
        timeout_seconds=1,
        python_executable=probe_python_executable,
    )
    timeout_result = timeout_probe.run_python_tool(
        code=(
            "import time\n"
            "time.sleep(5)\n"
            "print('should not finish')\n"
        ),
        fixture_input="{}",
    )
    output_probe = CreateToolSandbox(
        workspace_root=probe_workspace_root,
        max_output_bytes=64,
        python_executable=probe_python_executable,
    )
    limited_result = output_probe.run_python_tool(
        code=(
            "import sys\n"
            "print('O' * 200)\n"
            "print('E' * 200, file=sys.stderr)\n"
        ),
        fixture_input="{}",
    )
    network_blocked_result = create.sandbox.run_python_tool(
        code="import socket\nprint('should not run')\n",
        fixture_input="{}",
    )
    checks = [
        {
            "name": "python_fixture_execution",
            "status": "passed" if result.passed else "failed",
            "detail": "fixture executed in isolated workdir",
        },
        {
            "name": "production_secret_redaction",
            "status": (
                "passed"
                if all(f"{secret_name}=None" in result.stdout for secret_name in probed_secret_names)
                else "failed"
            ),
            "detail": "model and MCP API keys unavailable inside fixture process",
        },
        {
            "name": "filesystem_side_effect_preflight",
            "status": (
                "passed"
                if not blocked_result.passed
                and "disallowed_python_operation" in blocked_result.stderr
                else "failed"
            ),
            "detail": "disallowed filesystem operation blocked before execution",
        },
        {
            "name": "timeout_enforcement",
            "status": "passed" if timeout_result.timed_out else "failed",
            "detail": "long running fixture is terminated by runner timeout",
        },
        {
            "name": "output_limit",
            "status": "passed" if limited_result.output_truncated else "failed",
            "detail": "fixture stdout and stderr are capped before returning",
        },
        {
            "name": "network_import_preflight",
            "status": (
                "passed"
                if not network_blocked_result.passed
                and network_blocked_result.stderr
                == "disallowed_python_operation: import:socket"
                else "failed"
            ),
            "detail": "network imports are blocked before execution",
        },
    ]
    status = "passed" if all(check["status"] == "passed" for check in checks) else "failed"
    create.last_sandbox_probe_status = status
    return {
        "status": status,
        "writes_external_data": False,
        "runner": "CreateToolSandbox",
        "production_secrets_injected": False,
        "preflight_policy": SANDBOX_PREFLIGHT_POLICY,
        "timeout_enforced": True,
        "output_limited": True,
        "env_allowlist": list(SANDBOX_ENV_ALLOWLIST),
        "hardened_sandbox": False,
        "network_isolated": False,
        "checks": checks,
        "result": _redacted_sandbox_result(result),
        "blocked_result": _redacted_sandbox_result(blocked_result),
        "timeout_result": _redacted_sandbox_result(timeout_result),
        "limited_result": _redacted_sandbox_result(limited_result),
        "network_blocked_result": _redacted_sandbox_result(network_blocked_result),
    }


def _redacted_sandbox_result(result: Any) -> dict[str, Any]:
    payload = result.model_dump(mode="json")
    return _redact_runtime_value(payload)
