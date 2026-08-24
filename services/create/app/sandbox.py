from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

from services.create.app.schemas import CreateSandboxResult


SANDBOX_ENV_ALLOWLIST = ("PYTHONIOENCODING",)
SANDBOX_SECRET_BOUNDARY = "subprocess_env_allowlist"
SANDBOX_PREFLIGHT_POLICY = "ast_import_and_side_effect_preflight"
DEFAULT_SANDBOX_TIMEOUT_SECONDS = 5
DEFAULT_SANDBOX_MAX_OUTPUT_BYTES = 8192

ALLOWED_IMPORTS = frozenset({"decimal", "json", "math", "os", "statistics", "sys", "time"})
DISALLOWED_CALL_NAMES = frozenset(
    {
        "__import__",
        "compile",
        "delattr",
        "eval",
        "exec",
        "getattr",
        "globals",
        "input",
        "locals",
        "open",
        "setattr",
        "vars",
    }
)
DISALLOWED_CALL_ATTRIBUTES = frozenset(
    {
        "call",
        "check_call",
        "check_output",
        "chdir",
        "chmod",
        "chown",
        "connect",
        "exec",
        "execl",
        "execle",
        "execlp",
        "execlpe",
        "execv",
        "execve",
        "execvp",
        "execvpe",
        "fork",
        "forkpty",
        "link_to",
        "kill",
        "killpg",
        "mkdir",
        "makedirs",
        "open",
        "popen",
        "Popen",
        "putenv",
        "remove",
        "rename",
        "replace",
        "request",
        "rmdir",
        "run",
        "symlink_to",
        "system",
        "unlink",
        "unsetenv",
        "urlopen",
        "write",
        "write_bytes",
        "write_text",
    }
)
# These method names are only dangerous on a dangerous module receiver
# (e.g. os.replace, subprocess.run). The same names on safe receivers
# (str.replace, StringIO.write) are common and harmless, so the preflight
# only blocks them when the call target is a known-dangerous module.
DANGEROUS_CALL_RECEIVERS = frozenset(
    {
        "asyncio",
        "builtins",
        "ctypes",
        "importlib",
        "io",
        "multiprocessing",
        "os",
        "pathlib",
        "shutil",
        "signal",
        "socket",
        "subprocess",
        "sys",
        "threading",
    }
)


class CreateToolSandbox:
    def __init__(
        self,
        workspace_root: Path,
        timeout_seconds: int = DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        max_output_bytes: int = DEFAULT_SANDBOX_MAX_OUTPUT_BYTES,
        python_executable: str | None = None,
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        self.timeout_seconds = timeout_seconds
        self.max_output_bytes = max_output_bytes
        self.python_executable = python_executable or sys.executable
        self._counter = 0

    def run_python_tool(self, code: str, fixture_input: str) -> CreateSandboxResult:
        self._counter += 1
        workdir = (self.workspace_root / f"python-tool-{self._counter:03d}").resolve()
        workdir.mkdir(parents=True, exist_ok=True)
        safety_error = _python_safety_error(code)
        if safety_error:
            return CreateSandboxResult(
                passed=False,
                stdout="",
                stderr=f"disallowed_python_operation: {safety_error}",
                exit_code=None,
                workdir=str(workdir),
                preflight_policy=SANDBOX_PREFLIGHT_POLICY,
                timeout_seconds=self.timeout_seconds,
                max_output_bytes=self.max_output_bytes,
                env_allowlist=list(SANDBOX_ENV_ALLOWLIST),
                secret_boundary=SANDBOX_SECRET_BOUNDARY,
            )
        script_path = workdir / "tool.py"
        script_path.write_text(code, encoding="utf-8")
        try:
            completed = subprocess.run(
                # -X utf8 forces UTF-8 stdout/stderr regardless of platform
                # locale; -I (isolated) ignores PYTHON* env vars, so
                # PYTHONIOENCODING alone is not honoured on Windows.
                [self.python_executable, "-I", "-X", "utf8", "-S", str(script_path)],
                input=fixture_input,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=workdir,
                capture_output=True,
                timeout=self.timeout_seconds,
                env={SANDBOX_ENV_ALLOWLIST[0]: "utf-8"},
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            stdout, stdout_truncated = _limit_output(
                _coerce_text(exc.stdout),
                self.max_output_bytes,
            )
            stderr, stderr_truncated = _limit_output("sandbox timeout", self.max_output_bytes)
            return CreateSandboxResult(
                passed=False,
                stdout=stdout,
                stderr=stderr,
                exit_code=None,
                workdir=str(workdir),
                timed_out=True,
                output_truncated=stdout_truncated or stderr_truncated,
                preflight_policy=SANDBOX_PREFLIGHT_POLICY,
                timeout_seconds=self.timeout_seconds,
                max_output_bytes=self.max_output_bytes,
                env_allowlist=list(SANDBOX_ENV_ALLOWLIST),
                secret_boundary=SANDBOX_SECRET_BOUNDARY,
            )
        stdout, stdout_truncated = _limit_output(completed.stdout, self.max_output_bytes)
        stderr, stderr_truncated = _limit_output(completed.stderr, self.max_output_bytes)
        return CreateSandboxResult(
            passed=completed.returncode == 0,
            stdout=stdout,
            stderr=stderr,
            exit_code=completed.returncode,
            workdir=str(workdir),
            output_truncated=stdout_truncated or stderr_truncated,
            preflight_policy=SANDBOX_PREFLIGHT_POLICY,
            timeout_seconds=self.timeout_seconds,
            max_output_bytes=self.max_output_bytes,
            env_allowlist=list(SANDBOX_ENV_ALLOWLIST),
            secret_boundary=SANDBOX_SECRET_BOUNDARY,
        )


def _python_safety_error(code: str) -> str | None:
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return f"syntax_error:{exc.msg}"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root_name = alias.name.split(".", 1)[0]
                if root_name not in ALLOWED_IMPORTS:
                    return f"import:{root_name}"
        elif isinstance(node, ast.ImportFrom):
            root_name = (node.module or "").split(".", 1)[0]
            if root_name not in ALLOWED_IMPORTS:
                return f"import:{root_name}"
        elif isinstance(node, ast.Call):
            call_error = _call_safety_error(node.func)
            if call_error:
                return call_error
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return f"dunder_attribute:{node.attr}"
    return None


def _call_safety_error(func: ast.expr) -> str | None:
    if isinstance(func, ast.Name) and func.id in DISALLOWED_CALL_NAMES:
        return f"call:{func.id}"
    if (
        isinstance(func, ast.Attribute)
        and func.attr in DISALLOWED_CALL_ATTRIBUTES
        and _is_dangerous_receiver(func.value)
    ):
        return f"call:{func.attr}"
    return None


def _is_dangerous_receiver(value: ast.expr) -> bool:
    if isinstance(value, ast.Name):
        return value.id in DANGEROUS_CALL_RECEIVERS
    if isinstance(value, ast.Attribute):
        return value.attr in DANGEROUS_CALL_RECEIVERS
    return False


def _coerce_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="ignore")
    return value


def _limit_output(value: str, max_output_bytes: int) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_output_bytes:
        return value, False
    return encoded[:max_output_bytes].decode("utf-8", errors="ignore"), True
