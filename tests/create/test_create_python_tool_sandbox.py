from services.create.app.sandbox import CreateToolSandbox


def test_create_python_tool_sandbox_runs_fixture_without_runtime_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_MODEL_API_KEY", "model-secret")
    sandbox = CreateToolSandbox(workspace_root=tmp_path)

    result = sandbox.run_python_tool(
        code=(
            "import os, sys\n"
            "payload = sys.stdin.read().strip()\n"
            "print('payload=' + payload)\n"
            "print('secret=' + str(os.getenv('ANNA_MODEL_API_KEY')))\n"
        ),
        fixture_input='{"amount": 180000}',
    )

    assert result.passed is True
    assert "payload={\"amount\": 180000}" in result.stdout
    assert "secret=None" in result.stdout
    assert "model-secret" not in result.stdout
    assert result.workdir.startswith(str(tmp_path))
    assert result.env_allowlist == ["PYTHONIOENCODING"]
    assert result.secret_boundary == "subprocess_env_allowlist"
    assert result.preflight_policy == "ast_import_and_side_effect_preflight"
    assert result.timeout_seconds == 5
    assert result.max_output_bytes == 8192


def test_create_python_tool_sandbox_returns_real_failure_output(tmp_path):
    sandbox = CreateToolSandbox(workspace_root=tmp_path)

    result = sandbox.run_python_tool(
        code="raise RuntimeError('fixture failed')\n",
        fixture_input="{}",
    )

    assert result.passed is False
    assert "fixture failed" in result.stderr


def test_create_python_tool_sandbox_times_out_long_running_code(tmp_path):
    sandbox = CreateToolSandbox(workspace_root=tmp_path, timeout_seconds=1)

    result = sandbox.run_python_tool(
        code=(
            "import time\n"
            "time.sleep(5)\n"
            "print('should not finish')\n"
        ),
        fixture_input="{}",
    )

    assert result.passed is False
    assert result.exit_code is None
    assert result.timed_out is True
    assert result.stderr == "sandbox timeout"
    assert "should not finish" not in result.stdout


def test_create_python_tool_sandbox_limits_stdout_and_stderr(tmp_path):
    sandbox = CreateToolSandbox(workspace_root=tmp_path, max_output_bytes=64)

    result = sandbox.run_python_tool(
        code=(
            "import sys\n"
            "print('O' * 200)\n"
            "print('E' * 200, file=sys.stderr)\n"
        ),
        fixture_input="{}",
    )

    assert result.passed is True
    assert len(result.stdout.encode("utf-8")) <= 64
    assert len(result.stderr.encode("utf-8")) <= 64
    assert result.output_truncated is True


def test_create_python_tool_sandbox_rejects_network_imports_before_execution(tmp_path):
    sandbox = CreateToolSandbox(workspace_root=tmp_path)

    result = sandbox.run_python_tool(
        code=(
            "import socket\n"
            "print('should not run')\n"
        ),
        fixture_input="{}",
    )

    assert result.passed is False
    assert result.exit_code is None
    assert "disallowed_python_operation: import:socket" in result.stderr
    assert "should not run" not in result.stdout


def test_create_python_tool_sandbox_rejects_filesystem_side_effects_before_execution(tmp_path):
    workspace_root = tmp_path / "workspace"
    outside_file = tmp_path / "outside.txt"
    sandbox = CreateToolSandbox(workspace_root=workspace_root)

    result = sandbox.run_python_tool(
        code=(
            "from pathlib import Path\n"
            f"Path({str(outside_file)!r}).write_text('side effect')\n"
            "print('should not run')\n"
        ),
        fixture_input="{}",
    )

    assert result.passed is False
    assert result.exit_code is None
    assert "disallowed_python_operation" in result.stderr
    assert not outside_file.exists()


def test_create_python_tool_sandbox_allows_str_replace_on_safe_receivers(tmp_path):
    # str.replace and other data-method names must run on non-dangerous
    # receivers; only the same name on a dangerous module is blocked.
    sandbox = CreateToolSandbox(workspace_root=tmp_path / "workspace")

    result = sandbox.run_python_tool(
        code=(
            "amount = '1,234,567'\n"
            "clean = amount.replace(',', '')\n"
            "print(clean)\n"
        ),
        fixture_input="{}",
    )

    assert result.passed is True, result.stderr
    assert result.stdout.strip() == "1234567"


def test_create_python_tool_sandbox_still_blocks_os_replace(tmp_path):
    sandbox = CreateToolSandbox(workspace_root=tmp_path / "workspace")

    result = sandbox.run_python_tool(
        code="import os\nos.replace('a.txt', 'b.txt')\n",
        fixture_input="{}",
    )

    assert result.passed is False
    assert result.exit_code is None
    assert "disallowed_python_operation: call:replace" in result.stderr


def test_create_python_tool_sandbox_handles_unicode_stdout(tmp_path):
    # Generated tools routinely print Chinese text and check marks; the
    # sandbox subprocess must use UTF-8 stdout on every platform (Windows
    # defaults to cp1252 and would crash on these characters otherwise).
    sandbox = CreateToolSandbox(workspace_root=tmp_path / "workspace")

    result = sandbox.run_python_tool(
        code="print('结果 ✓ 金额→壹元')\n",
        fixture_input="{}",
    )

    assert result.passed is True, result.stderr
    assert "壹元" in result.stdout
